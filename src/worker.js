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
import { toIcs, normalize, mealError, pickDate, pickTime, looksLikeMeal } from './meals.js';
import { fetchZiggleNotices, toCandidate } from './ziggle.js';

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

// 지꽁밥 후보는 30일이면 지워진다. 승인 안 한 건 어차피 지난 행사다.
const QUEUE_TTL = 30 * 24 * 60 * 60;

// 취소한 이벤트를 달력에 얼마나 더 실어 보낼지. 이 기간이 지나면 지운다.
const CANCEL_KEEP_DAYS = 30;

// meal: 키들을 모아 읽기 캐시를 다시 쓴다.
// 목록 조회 때마다 list() 를 돌리면 KV 무료 한도를 태운다 — latest 와 같은 이유다.
async function refreshMeals(env) {
  const { keys } = await env.GIST.list({ prefix: 'meal:' });
  const cutoff = Date.now() - CANCEL_KEEP_DAYS * 86400000;

  const meals = [];
  for (const k of keys) {
    const m = await env.GIST.get(k.name, 'json');
    if (!m) continue;
    if (m.status === 'cancelled' && Date.parse(m.updatedAt) < cutoff) {
      await env.GIST.delete(k.name);
      continue;
    }
    meals.push(m);
  }

  meals.sort((a, b) => a.date.localeCompare(b.date));
  await env.GIST.put('meals', JSON.stringify(meals));
  return meals;
}

// 크론이 이미 파싱해둔 공지에서 식사 행사 후보만 골라 큐에 넣는다.
// 게시판을 다시 긁지 않으므로 추가 요청이 0이다.
// KST 기준 오늘. 연도 없는 날짜를 추측할 때 기준으로 쓴다.
const todayKST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// 후보 하나를 큐에 넣는다. 소스가 둘(학사공지·지글)이라 한 곳에 둔다.
// 이미 승인했거나 이미 큐에 있으면 건드리지 않는다 — 승인 화면에서 고쳐둔
// 값을 30분 뒤 크론이 덮어쓰면 안 된다.
async function queueCandidate(env, c) {
  if (await env.GIST.get(`meal:${c.id}`)) return false;
  if (await env.GIST.get(`mealq:${c.id}`)) return false;

  await env.GIST.put(
    `mealq:${c.id}`,
    JSON.stringify({ ...c, receivedAt: new Date().toISOString() }),
    { expirationTtl: QUEUE_TTL },
  );
  return true;
}

async function queueFromNotices(items, board, env) {
  const today = todayKST();
  let added = 0;

  for (const c of items) {
    if (!looksLikeMeal(c.title)) continue;
    const ok = await queueCandidate(env, {
      id: `gist:${c.no}`,
      title: c.title,
      text: c.title,
      source: 'gist',
      sourceUrl: detailUrl(board, c.no),
      // 게시 날짜(c.date)를 행사 날짜로 쓰지 않는다. 둘은 다르고, 틀린 날짜가
      // 달력에 들어가는 것이 빈칸보다 나쁘다.
      guess: { date: pickDate(c.title, today), start: pickTime(c.title) },
    });
    if (ok) added += 1;
  }

  if (added > 0) console.log(`지꽁밥 후보(학사공지) ${added}건 적재`);
  return added;
}

// 지글은 남의 서비스다. 토큰이 만료되거나 API 가 바뀌면 여기서 실패하는데,
// 그렇다고 공지 알림까지 말려들면 안 된다. 통째로 감싸고 조용히 물러난다.
async function queueFromZiggle(env) {
  let items;
  try {
    items = await fetchZiggleNotices(env);
  } catch (err) {
    console.error('지글 수집 실패:', String(err));
    if (err.tokenDead) await noteZiggleTokenDead(env);
    return 0;
  }

  await env.GIST.delete('ziggleAlerted'); // 살아났으니 알림 억제를 푼다

  const today = todayKST();
  let added = 0;
  for (const n of items) {
    const c = toCandidate(n, today);
    if (c && (await queueCandidate(env, c))) added += 1;
  }

  if (added > 0) console.log(`지꽁밥 후보(지글) ${added}건 적재`);
  return added;
}

// 토큰이 죽으면 사람이 지글에 다시 로그인해 넣는 수밖에 없다. 조용히 죽으면
// 몇 주 뒤에야 알아채므로 알린다. 30분마다 도배되지 않게 하루 한 번만.
async function noteZiggleTokenDead(env) {
  if (await env.GIST.get('ziggleAlerted')) return;
  await env.GIST.put('ziggleAlerted', '1', { expirationTtl: 24 * 3600 });

  const key = await env.GIST.get('adminSub');
  if (!key) return;
  const sub = await env.GIST.get(key, 'json');
  if (!sub) return;

  await sendPush(
    sub,
    {
      title: '⚠️ 지글 토큰 만료',
      body: '지글에 다시 로그인해 토큰을 넣어주세요. DEPLOY.md 참고',
      url: '/',
      tag: `ziggle-${Date.now()}`,
    },
    env,
  ).catch((e) => console.error('관리자 알림 실패:', String(e)));
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

  // 지꽁밥 큐 적재는 푸시 발송과 lastNo 갱신이 끝난 다음, 맨 마지막에 한다.
  // 앱의 본질은 알림 발송이고 식사 큐는 30분 늦어도 된다 — 여기서 KV 오류나
  // subrequest 한도 초과로 던져도 위의 발송과 lastNo 갱신은 이미 끝나 있다.
  // 순서를 바꾸는 김에 이 작업이 쓰는 KV 요청도 발송이 쓰는 subrequest
  // 예산 밖으로 빠진다.
  await queueFromNotices(items, board, env);
  await queueFromZiggle(env);

  console.log(`확인 완료: 파싱 ${items.length}건, 새 글 ${fresh.length}건, 발송 ${sent}건`);
  return { fresh: fresh.length, sent };
}

// ponytail: 300건 넘으면 오래된 것부터 버린다. 한 학기치는 충분히 남는다.
// 더 필요하면 KV 값 하나가 아니라 연도별로 키를 쪼개야 한다.
const ARCHIVE_MAX = 300;

// 구독은 180일 뒤 KV 가 알아서 지운다.
//
// 왜 필요한가: PWA 를 지우거나 알림을 껐다 켜면 푸시 서비스가 새 endpoint 를
// 발급한다 → sub: 키가 하나 더 생기고 옛 키는 남는다. 옛 키 정리는 실제로
// 푸시를 쏠 때 410/404 를 받아야만 되는데, 새 공지가 없으면 그 코드가 아예
// 안 돈다. 그래서 구독자 수가 실제보다 부풀어 오른다.
//
// 앱을 열 때마다 /api/subscribe 가 다시 불려 TTL 이 180일로 밀린다.
// 살아 있는 기기는 계속 갱신되고, 사라진 기기는 조용히 만료된다.
const SUB_TTL = 180 * 24 * 60 * 60;

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

  // ponytail: Workers 무료 플랜의 호출당 50개 한도는 fetch 뿐 아니라 KV 호출도
  // 센다. 크론 한 번이 여기 도달하기 전에 이미 게시판 fetch, lastNo, failStreak,
  // 아카이브·카테고리 병합, refreshCount, 이 함수의 list 로 9개를 쓰고, 구독자
  // 한 명당 KV get + push fetch 로 2개씩 더 쓴다. 그래서 알림까지의 상한은
  // 구독자 20명 근처다. 그 이상이면 유료 플랜(1000개)으로 올리거나 여러 번에
  // 나눠 보내야 한다.
  //
  // 지꽁밥 후보 적재는 이 발송이 끝난 뒤에 돈다. 지글 토큰을 새로 받는 회차는
  // 거기서만 7~8개를 더 쓰므로 한도를 먼저 넘을 수 있는데, 그때 죽는 것은
  // 후보 적재뿐이고 알림은 이미 나간 뒤다. 순서가 그래서 중요하다.
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

    // 지꽁밥 — 확정 목록. 취소분은 화면에서 뺀다(달력에는 남아야 한다).
    // GET 을 명시해야 한다. 안 그러면 아래 POST /api/meals 가 여기에 먼저 걸려
    // 저장 대신 목록을 돌려준다.
    if (pathname === '/api/meals' && req.method === 'GET') {
      const all = (await env.GIST.get('meals', 'json')) ?? [];
      return json(all.filter((m) => m.status !== 'cancelled'));
    }

    // 캘린더 구독용. 취소분까지 통째로 내보낸다 — 빼버리면 이미 구독한
    // 달력에 유령으로 남는다.
    if (pathname === '/api/meals.ics' && req.method === 'GET') {
      const all = (await env.GIST.get('meals', 'json')) ?? [];
      return new Response(toIcs(all, new Date()), {
        headers: {
          'content-type': 'text/calendar; charset=utf-8',
          'cache-control': 'public, max-age=600',
        },
      });
    }

    if (pathname === '/api/subscribe' && req.method === 'POST') {
      const sub = await readSubscription(req);
      if (!sub) return json({ error: '올바른 구독 정보가 아닙니다' }, 400);

      const key = await subKey(sub.endpoint);

      // 앱을 열 때마다 여기로 다시 온다(TTL 갱신). 이미 있는 키면 인원수가
      // 변할 리 없으니 list() 를 돌리지 않는다 — get 한 번이 훨씬 싸다.
      const isNew = (await env.GIST.get(key)) === null;

      await env.GIST.put(
        key,
        JSON.stringify({ endpoint: sub.endpoint, expirationTime: null, keys: sub.keys }),
        { expirationTtl: SUB_TTL },
      );

      // 관리자 토큰을 달고 구독하면 이 기기가 장애 알림을 받는다.
      // 페이지에서 #admin=<토큰> 으로 한 번만 등록한다.
      if (authed(req, env)) await env.GIST.put('adminSub', key);

      if (isNew) await refreshCount(env);
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
        console.error('테스트 푸시: 만료된 구독', res.status, new URL(sub.endpoint).host);
        // fixable: 앱이 "알림 다시 켜기" 버튼을 띄울 수 있다는 표시.
        return json(
          { error: '이 구독은 만료됐습니다', status: res.status, fixable: true },
          410,
        );
      }

      // 실패 원인은 본문에만 있다 (APNs 의 BadJwtToken, FCM 의
      // UNREGISTERED 등). 크론 쪽은 이미 본문을 남기는데 여기만 버리고
      // 있어서, 테스트 버튼이 실패해도 코드 하나 말고는 알 길이 없었다.
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        console.error('테스트 푸시 실패', res.status, detail);
        return json(
          {
            error: `푸시 서비스 응답 ${res.status}`,
            status: res.status,
            detail,
            // 400·403 은 구독과 서버 키가 어긋난 경우라 다시 구독하면 풀린다.
            fixable: res.status === 400 || res.status === 403,
          },
          502,
        );
      }
      return json({ ok: true });
    }

    // 크론을 기다리지 않고 지금 당장 한 번 돌린다.
    // 알림이 실제로 오는지 테스트할 때 쓴다. 토큰 없이는 못 부른다 —
    // 열어두면 아무나 우리 이름으로 GIST 서버를 계속 긁게 된다.
    if (pathname === '/api/run' && req.method === 'POST') {
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
      return json(await checkBoard(env));
    }

    // 승인 대기 후보. 관리자 화면이 읽는다.
    if (pathname === '/api/meals/queue' && req.method === 'GET') {
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
      const { keys } = await env.GIST.list({ prefix: 'mealq:' });
      const out = [];
      for (const k of keys) {
        const c = await env.GIST.get(k.name, 'json');
        if (c) out.push(c);
      }
      out.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
      return json(out);
    }

    // 후보 적재. 크론과 Apps Script 가 같은 문으로 들어온다.
    if (pathname === '/api/meals/queue' && req.method === 'POST') {
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);

      const body = await req.json().catch(() => null);
      if (!body?.id || !body?.title) return json({ error: 'id 와 title 이 필요합니다' }, 400);

      const text = String(body.text ?? body.title).slice(0, 4000);
      const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

      const candidate = {
        id: String(body.id).slice(0, 120),
        title: String(body.title).slice(0, 200),
        text,
        source: String(body.source ?? 'manual').slice(0, 20),
        sourceUrl: String(body.sourceUrl ?? '').slice(0, 500),
        receivedAt: new Date().toISOString(),
        // 뽑을 수 있는 만큼만 미리 뽑아둔다. 나머지는 승인 화면에서 채운다.
        guess: { date: pickDate(text, today), start: pickTime(text) },
      };

      await env.GIST.put(`mealq:${candidate.id}`, JSON.stringify(candidate), {
        expirationTtl: QUEUE_TTL,
      });
      return json({ ok: true, id: candidate.id });
    }

    // 승인 = 확정에 넣기. 직접 추가도 같은 문으로 들어온다 — 하는 일이 같다.
    if (pathname === '/api/meals' && req.method === 'POST') {
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);

      const body = await req.json().catch(() => null);
      if (!body) return json({ error: '본문이 JSON 이 아닙니다' }, 400);

      const prev = body.id ? await env.GIST.get(`meal:${body.id}`, 'json') : null;
      const meal = normalize(body, prev);

      const problem = mealError(meal);
      if (problem) return json({ error: problem }, 400);

      await env.GIST.put(`meal:${meal.id}`, JSON.stringify(meal));
      await env.GIST.delete(`mealq:${meal.id}`); // 승인했으면 큐에서 뺀다
      await refreshMeals(env);
      return json({ ok: true, meal });
    }

    // 삭제는 진짜로 지우지 않는다. 취소 표시로 바꿔야 구독자 달력에서 사라진다.
    if (pathname.startsWith('/api/meals/') && req.method === 'DELETE') {
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);

      // 깨진 퍼센트 인코딩(예: /api/meals/%)은 decodeURIComponent 가 던진다.
      // 그대로 두면 잘못된 주소 하나가 500 으로 보인다.
      let id;
      try {
        id = decodeURIComponent(pathname.slice('/api/meals/'.length));
      } catch {
        return json({ error: '주소가 올바르지 않습니다' }, 400);
      }
      const prev = await env.GIST.get(`meal:${id}`, 'json');
      if (!prev) return json({ error: '없는 이벤트입니다' }, 404);

      await env.GIST.put(`meal:${id}`, JSON.stringify(normalize({ status: 'cancelled' }, prev)));
      await refreshMeals(env);
      return json({ ok: true });
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
