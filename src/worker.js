// ===========================================================
//  Cloudflare Worker 본체
//
//  두 개의 입구가 있다:
//    fetch()     — 브라우저가 사이트를 열거나 API 를 부를 때
//    scheduled() — 30분마다 Cloudflare 가 알아서 부를 때 (크론)
//
//  Node 의 require / fs / http 는 쓰지 않는다.
//  Request, Response, fetch, crypto.subtle — 브라우저와 같은 표준 API 만 쓴다.
// ===========================================================

import { parse } from './parse.js';
import { diff } from './diff.js';
import { sendPush } from './push.js';

const BOARD = 'https://www.gist.ac.kr/kr/html/sub05/050209.html';
const detailUrl = (no) => `${BOARD}?mode=V&no=${no}`;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

// -----------------------------------------------------------
//  구독 검증
//
//  /api/subscribe 는 누구나 부를 수 있는 공개 엔드포인트다.
//  검증 없이 저장하면 아무 URL 이나 KV 에 쌓이고, 크론이 매번 그 주소로
//  요청을 보내게 된다(= 우리 서버가 남을 공격하는 도구가 된다).
//  그래서 실제 푸시 서비스 주소인지 확인한다.
// -----------------------------------------------------------
const PUSH_HOSTS =
  /(^|\.)(push\.services\.mozilla\.com|fcm\.googleapis\.com|android\.googleapis\.com|push\.apple\.com|notify\.windows\.com)$/;

function validSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string') return false;

  let url;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (!PUSH_HOSTS.test(url.hostname)) return false;

  const k = sub.keys;
  return Boolean(
    k &&
      typeof k.p256dh === 'string' &&
      typeof k.auth === 'string' &&
      k.p256dh.length > 0 && k.p256dh.length <= 200 &&
      k.auth.length > 0 && k.auth.length <= 100,
  );
}

// endpoint 는 길고 제각각이라 KV 키로 쓰기 나쁘다. 해시로 고정 길이를 만든다.
async function subKey(endpoint) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sub:${hex}`;
}

async function readSubscription(req) {
  const body = await req.text();
  if (body.length > 2000) return null; // 정상 구독은 500바이트 남짓이다
  try {
    const sub = JSON.parse(body);
    return validSubscription(sub) ? sub : null;
  } catch {
    return null;
  }
}

// ===========================================================
//  크론이 실제로 하는 일
// ===========================================================
async function checkBoard(env) {
  const res = await fetch(BOARD, {
    headers: { 'user-agent': 'gist-notice (https://github.com/hidudu0/gist-notice)' },
  });
  if (!res.ok) {
    console.error('게시판 응답 실패:', res.status);
    return { fresh: 0, sent: 0 };
  }

  const items = parse(await res.text());
  const lastNo = Number(await env.GIST.get('lastNo')) || 0;
  const { fresh, maxNo } = diff(items, lastNo);

  // 앱 목록 화면용 캐시. 알림 여부와 무관하게 항상 갱신한다.
  await env.GIST.put('latest', JSON.stringify(items.slice(0, 20)));

  let sent = 0;
  if (fresh.length > 0) sent = await notifyAll(fresh, env);

  if (maxNo !== lastNo) await env.GIST.put('lastNo', String(maxNo));

  console.log(`확인 완료: 파싱 ${items.length}건, 새 글 ${fresh.length}건, 발송 ${sent}건`);
  return { fresh: fresh.length, sent };
}

async function notifyAll(fresh, env) {
  // 새 글이 여러 건이면 알림도 여러 개 쏘는 대신 하나로 묶는다.
  // 잠금화면이 도배되지 않고, 아래 subrequest 한도에도 여유가 생긴다.
  const data =
    fresh.length === 1
      ? {
          title: fresh[0].title,
          body: `[${fresh[0].category}] ${fresh[0].date}`,
          url: detailUrl(fresh[0].no),
        }
      : {
          title: `새 학사공지 ${fresh.length}건`,
          // 하루 두 번만 확인하므로 한 번에 여러 건이 쌓인다.
          // 줄바꿈으로 나열해야 알림을 펼쳤을 때 제목이 읽힌다.
          body: fresh.map((c) => c.title).join('\n').slice(0, 300),
          url: BOARD,
        };

  const list = await env.GIST.list({ prefix: 'sub:' });

  // ponytail: Workers 무료 플랜은 호출 1회당 바깥으로 나가는 fetch 가 50개까지다.
  // 게시판 fetch 1개를 빼면 구독자 49명이 상한. 그 이상이면 유료 플랜(1000개)
  // 으로 올리거나 여러 번에 나눠 보내야 한다.
  const results = await Promise.allSettled(
    list.keys.map(async ({ name }) => {
      const sub = await env.GIST.get(name, 'json');
      if (!sub) return 'missing';

      const res = await sendPush(sub, data, env);

      // 404/410 = 구독이 죽었다 (앱 삭제, 알림 끔, 브라우저 데이터 삭제).
      // 그냥 두면 매번 실패하니 정리한다.
      if (res.status === 404 || res.status === 410) {
        await env.GIST.delete(name);
        return 'gone';
      }
      if (!res.ok) {
        console.error('푸시 실패', res.status, await res.text().catch(() => ''));
        return 'error';
      }
      return 'ok';
    }),
  );

  // 한 명이 실패해도 나머지는 간다. 그래서 all 이 아니라 allSettled 를 쓴다.
  return results.filter((r) => r.status === 'fulfilled' && r.value === 'ok').length;
}

// ===========================================================
//  입구
// ===========================================================
export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);

    if (pathname === '/api/vapid') {
      return json({ key: env.VAPID_PUBLIC_KEY });
    }

    if (pathname === '/api/latest') {
      return json((await env.GIST.get('latest', 'json')) ?? []);
    }

    if (pathname === '/api/subscribe' && req.method === 'POST') {
      const sub = await readSubscription(req);
      if (!sub) return json({ error: '올바른 구독 정보가 아닙니다' }, 400);
      await env.GIST.put(
        await subKey(sub.endpoint),
        JSON.stringify({ endpoint: sub.endpoint, expirationTime: null, keys: sub.keys }),
      );
      return json({ ok: true });
    }

    if (pathname === '/api/unsubscribe' && req.method === 'POST') {
      const sub = await readSubscription(req);
      if (!sub) return json({ error: '올바른 구독 정보가 아닙니다' }, 400);
      await env.GIST.delete(await subKey(sub.endpoint));
      return json({ ok: true });
    }

    // 크론을 기다리지 않고 지금 당장 한 번 돌린다.
    // 알림이 실제로 오는지 테스트할 때 쓴다. 토큰 없이는 못 부른다 —
    // 열어두면 아무나 우리 이름으로 GIST 서버를 계속 긁게 된다.
    if (pathname === '/api/run' && req.method === 'POST') {
      if (!env.ADMIN_TOKEN || req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      return json(await checkBoard(env));
    }

    // 나머지는 public/ 의 정적 파일
    return env.ASSETS.fetch(req);
  },

  async scheduled(event, env, ctx) {
    // waitUntil 로 감싸야 응답 후에도 작업이 끝까지 돈다
    ctx.waitUntil(checkBoard(env));
  },
};
