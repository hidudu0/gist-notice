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

// 게시판 주소는 wrangler.jsonc 의 vars.BOARD_URL 한 곳에만 있다.
const detailUrl = (board, no) => `${board}?mode=V&no=${no}`;

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

// 관리자용 엔드포인트 잠금. 열어두면 아무나 우리 이름으로 GIST 서버를 긁거나
// 구독자 전원에게 아무 메시지나 쏠 수 있다.
const authed = (req, env) =>
  Boolean(env.ADMIN_TOKEN) && req.headers.get('x-admin-token') === env.ADMIN_TOKEN;

// 구독자 수는 화면에 보여주려고 KV 에 캐시해둔다.
// 페이지가 열릴 때마다 list() 를 돌리면 KV 무료 한도를 태운다.
async function refreshCount(env) {
  const list = await env.GIST.list({ prefix: 'sub:' });
  await env.GIST.put('subs', String(list.keys.length));
  return list.keys.length;
}

// 404/410 = 구독이 죽었다 (앱 삭제, 알림 끔, 브라우저 데이터 삭제).
// 그냥 두면 매번 실패하니 정리한다. 크론 발송과 테스트 버튼이 같은 규칙을
// 써야 해서 한 곳에 둔다 — 두 벌이면 한쪽만 고치고 다른 쪽이 남는다.
async function dropIfGone(res, key, env) {
  if (res.status !== 404 && res.status !== 410) return false;
  await env.GIST.delete(key);
  return true;
}

// ===========================================================
//  크론이 실제로 하는 일
// ===========================================================
async function checkBoard(env) {
  const board = env.BOARD_URL;
  const res = await fetch(board, {
    headers: { 'user-agent': 'gist-notice (https://github.com/hidudu0/gist-notice)' },
  });
  if (!res.ok) {
    console.error('게시판 응답 실패:', res.status);
    await noteFailure(env, `게시판이 HTTP ${res.status} 를 돌려줬습니다`);
    return { fresh: 0, sent: 0 };
  }

  const items = parse(await res.text());

  // 파싱 결과가 0건이면 게시판 마크업이 바뀐 것이다.
  // 이 경우 diff 가 조용히 통과하므로 알림이 영영 안 온다 — 그래도
  // 로그 말고는 아무 신호가 없어서, 죽은 줄도 모르고 방치된다.
  if (items.length === 0) {
    console.error('파싱 0건 — 게시판 마크업이 바뀌었을 수 있다');
    await noteFailure(env, '게시판 마크업이 바뀐 것 같습니다. parse.js 확인 필요');
    return { fresh: 0, sent: 0 };
  }
  await env.GIST.delete('failStreak');

  const lastNo = Number(await env.GIST.get('lastNo')) || 0;
  const { fresh, maxNo } = diff(items, lastNo);

  // 앱 화면·검색용 목록. 게시판은 한 페이지에 25건만 주므로 덮어쓰면
  // 검색할 게 늘 25건뿐이다. 그래서 지울 때까지 계속 쌓는다.
  await mergeArchive(items, env);

  // 검색 칩에 쓸 카테고리 목록. 지금까지 본 것들의 합집합.
  await mergeCategories(items, env);
  await refreshCount(env);

  let sent = 0;
  if (fresh.length > 0) sent = await notifyAll(fresh, board, env);

  if (maxNo !== lastNo) await env.GIST.put('lastNo', String(maxNo));

  console.log(`확인 완료: 파싱 ${items.length}건, 새 글 ${fresh.length}건, 발송 ${sent}건`);
  return { fresh: fresh.length, sent };
}

// ponytail: 300건 넘으면 오래된 것부터 버린다. 한 학기치는 충분히 남는다.
// 더 필요하면 KV 값 하나가 아니라 연도별로 키를 쪼개야 한다.
const ARCHIVE_MAX = 300;

async function mergeArchive(items, env) {
  const old = (await env.GIST.get('latest', 'json')) ?? [];

  // 같은 글이 두 번 들어가지 않도록 글 번호로 합친다.
  const byNo = new Map(old.map((c) => [c.no, c]));
  for (const c of items) byNo.set(c.no, c);

  const merged = [...byNo.values()].sort((a, b) => b.no - a.no).slice(0, ARCHIVE_MAX);
  await env.GIST.put('latest', JSON.stringify(merged));
}

async function mergeCategories(items, env) {
  const known = (await env.GIST.get('categories', 'json')) ?? [];
  const set = new Set(known);
  const before = set.size;
  for (const c of items) if (c.category) set.add(c.category);
  if (set.size !== before) await env.GIST.put('categories', JSON.stringify([...set].sort()));
}

// -----------------------------------------------------------
//  파싱/수집 실패 감시
//
//  한 번 실패는 게시판 점검일 수 있으니 넘긴다. 두 번 연속이면 관리자
//  기기로 푸시를 한 번 보낸다. 계속 보내면 그것도 스팸이라 딱 한 번만.
// -----------------------------------------------------------
async function noteFailure(env, reason) {
  const n = (Number(await env.GIST.get('failStreak')) || 0) + 1;
  await env.GIST.put('failStreak', String(n));
  if (n !== 2) return;

  const key = await env.GIST.get('adminSub');
  if (!key) return; // 관리자 기기가 등록되지 않았다. 로그만 남는다.
  const sub = await env.GIST.get(key, 'json');
  if (!sub) return;

  await sendPush(
    sub,
    { title: '⚠️ 공지 확인 실패', body: reason, url: '/', tag: `fail-${Date.now()}` },
    env,
  ).catch((e) => console.error('관리자 알림 실패:', String(e)));
}

// 새 공지를 알림 한 건으로 만들어 전원에게 보낸다.
function notifyAll(fresh, board, env) {
  // 새 글이 여러 건이면 알림도 여러 개 쏘는 대신 하나로 묶는다.
  // 잠금화면이 도배되지 않고, 아래 subrequest 한도에도 여유가 생긴다.
  const data =
    fresh.length === 1
      ? {
          title: fresh[0].title,
          body: `[${fresh[0].category}] ${fresh[0].date}`,
          url: detailUrl(board, fresh[0].no),
        }
      : {
          title: `새 학사공지 ${fresh.length}건`,
          // 줄바꿈으로 나열해야 알림을 펼쳤을 때 제목이 읽힌다.
          body: fresh.map((c) => c.title).join('\n').slice(0, 300),
          url: board,
        };

  return sendToAll(data, env);
}

// 구독자 전원에게 알림 하나를 보낸다. 공지 알림과 직접 보내는 메시지가
// 같은 경로를 쓴다 — 발송·실패처리 로직을 두 벌 만들지 않기 위해서.
async function sendToAll(data, env) {
  const list = await env.GIST.list({ prefix: 'sub:' });

  // ponytail: Workers 무료 플랜은 호출 1회당 바깥으로 나가는 fetch 가 50개까지다.
  // 게시판 fetch 1개를 빼면 구독자 49명이 상한. 그 이상이면 유료 플랜(1000개)
  // 으로 올리거나 여러 번에 나눠 보내야 한다.
  const results = await Promise.allSettled(
    list.keys.map(async ({ name }) => {
      const sub = await env.GIST.get(name, 'json');
      if (!sub) return 'missing';

      const res = await sendPush(sub, data, env);

      if (await dropIfGone(res, name, env)) return 'gone';
      if (!res.ok) {
        console.error('푸시 실패', res.status, await res.text().catch(() => ''));
        return 'error';
      }
      return 'ok';
    }),
  );

  // 한 명이 실패해도 나머지는 간다. 그래서 all 이 아니라 allSettled 를 쓴다.
  // 던져진 예외는 여기서 로그로 남긴다. 안 남기면 "발송 0건" 만 보이고
  // 왜 실패했는지 알 길이 없다.
  for (const r of results) {
    if (r.status === 'rejected') console.error('푸시 예외:', String(r.reason?.stack || r.reason));
  }
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

    // 화면 상단의 "N명 구독 중" 과 검색 칩에 쓸 카테고리 목록.
    // 둘 다 크론이 KV 에 미리 넣어둔 값이라 읽기만 한다.
    if (pathname === '/api/meta') {
      return json({
        subs: Number(await env.GIST.get('subs')) || 0,
        categories: (await env.GIST.get('categories', 'json')) ?? [],
      });
    }

    if (pathname === '/api/subscribe' && req.method === 'POST') {
      const sub = await readSubscription(req);
      if (!sub) return json({ error: '올바른 구독 정보가 아닙니다' }, 400);

      const key = await subKey(sub.endpoint);
      await env.GIST.put(
        key,
        JSON.stringify({ endpoint: sub.endpoint, expirationTime: null, keys: sub.keys }),
      );

      // 관리자 토큰을 달고 구독하면 이 기기가 장애 알림을 받는다.
      // 페이지에서 #admin=<토큰> 으로 한 번만 등록한다.
      if (authed(req, env)) await env.GIST.put('adminSub', key);

      await refreshCount(env);
      return json({ ok: true });
    }

    if (pathname === '/api/unsubscribe' && req.method === 'POST') {
      const sub = await readSubscription(req);
      if (!sub) return json({ error: '올바른 구독 정보가 아닙니다' }, 400);
      await env.GIST.delete(await subKey(sub.endpoint));
      await refreshCount(env);
      return json({ ok: true });
    }

    // 알림이 실제로 오는지 지금 확인한다. 자기 자신에게만 간다 —
    // 보내려면 그 기기의 endpoint 와 암호키를 알아야 하기 때문이다.
    if (pathname === '/api/test' && req.method === 'POST') {
      const sub = await readSubscription(req);
      if (!sub) return json({ error: '올바른 구독 정보가 아닙니다' }, 400);

      const key = await subKey(sub.endpoint);
      const res = await sendPush(
        sub,
        {
          title: '알림 테스트',
          body: '이 알림이 보이면 정상입니다',
          url: '/',
          tag: `test-${Date.now()}`,
        },
        env,
      );

      // 죽은 구독이면 여기서 정리한다. 크론을 기다리지 않고 바로 알 수 있는
      // 유일한 지점이라, 테스트 버튼이 청소도 겸한다.
      if (await dropIfGone(res, key, env)) {
        await refreshCount(env);
        return json({ error: '이 구독은 만료됐습니다. 알림을 껐다가 다시 켜주세요' }, 410);
      }
      if (!res.ok) return json({ error: `푸시 서비스 응답 ${res.status}` }, 502);
      return json({ ok: true });
    }

    // 크론을 기다리지 않고 지금 당장 한 번 돌린다.
    // 알림이 실제로 오는지 테스트할 때 쓴다. 토큰 없이는 못 부른다 —
    // 열어두면 아무나 우리 이름으로 GIST 서버를 계속 긁게 된다.
    if (pathname === '/api/run' && req.method === 'POST') {
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
      return json(await checkBoard(env));
    }

    // 공지와 무관하게 내가 직접 구독자 전원에게 메시지를 보낸다.
    // 사용:  npm run send "제목" "내용" [링크]
    if (pathname === '/api/broadcast' && req.method === 'POST') {
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);

      const msg = await req.json().catch(() => null);
      if (!msg?.title || !msg?.body) {
        return json({ error: 'title 과 body 가 필요합니다' }, 400);
      }

      // 푸시 본문은 4KB 를 넘으면 발송이 실패한다. 넉넉히 자른다.
      const data = {
        title: String(msg.title).slice(0, 100),
        body: String(msg.body).slice(0, 500),
        url: msg.url ? String(msg.url).slice(0, 500) : '/',
        // 공지 알림을 덮어쓰지 않도록 매번 다른 tag 를 준다
        tag: `bc-${Date.now()}`,
      };
      return json({ sent: await sendToAll(data, env) });
    }

    // 나머지는 public/ 의 정적 파일
    return env.ASSETS.fetch(req);
  },

  async scheduled(event, env, ctx) {
    // waitUntil 로 감싸야 응답 후에도 작업이 끝까지 돈다
    ctx.waitUntil(checkBoard(env));
  },
};
