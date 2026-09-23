// ===========================================================
//  지글(ziggle.gistory.me) 에서 공지를 읽는다
//
//  지글은 Vite+React SPA 라 학사공지처럼 HTML 을 긁을 게 없다. 백엔드 API 를
//  직접 부르는데, 토큰이 두 겹이라는 게 함정이다. IdP(account.gistory.me)
//  토큰으로는 지글 API 가 열리지 않는다:
//
//    KV ziggleRefresh → IdP access → POST /auth/login → 지글 access → /notice
//
//  실측값과 근거는 docs/superpowers/specs/2026-09-23-zigongbap-design.md 에 있다.
//  요약하면: client secret 은 필요 없고(PKCE 공개 클라이언트), IdP access 는
//  3시간, refresh 는 90일이며 쓸 때마다 회전한다.
// ===========================================================

import { looksLikeMeal, pickDate, pickTime } from './meals.js';

const IDP_TOKEN_URL = 'https://api.account.gistory.me/oauth/token';
const ZIGGLE_API = 'https://api.ziggle.gistory.me';
const CLIENT_ID = 'b0c3a25f-1291-410c-bac3-192094d47c77';
const REDIRECT_URI = 'https://ziggle.gistory.me/auth/callback';

// 지글 토큰의 수명은 응답에 안 적혀 있다. IdP access 가 3시간이니 그보다
// 짧게 캐시하고, 그래도 401 이 오면 한 번 새로 받아 다시 시도한다.
const TOKEN_TTL = 60 * 60;

export const noticeUrl = (id) => `https://ziggle.gistory.me/notice/${id}`;

// -----------------------------------------------------------
//  토큰
// -----------------------------------------------------------
async function mintToken(env) {
  const refresh = await env.GIST.get('ziggleRefresh');
  if (!refresh) throw new Error('KV ziggleRefresh 가 비어 있다');

  const res = await fetch(IDP_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    const err = new Error(`IdP 갱신 ${res.status} ${detail}`);
    // 400·401 은 토큰이 죽은 것이다. 재시도로는 안 풀리고 사람이 다시 넣어야 한다.
    err.tokenDead = res.status === 400 || res.status === 401;
    throw err;
  }

  const idp = await res.json();

  // refresh token 은 한 번 쓰면 회전한다. 쓰기 전에 새 값부터 저장한다 —
  // 여기서 순서가 뒤집히면 다음 회차가 죽은 토큰으로 들어가고, 복구는
  // 지글에 다시 로그인해 손으로 넣는 것밖에 없다.
  if (idp.refresh_token) await env.GIST.put('ziggleRefresh', idp.refresh_token);

  const login = await fetch(`${ZIGGLE_API}/auth/login`, {
    method: 'POST',
    // IdP 토큰은 헤더로 보내야 한다. 본문에 실으면 401 이다.
    headers: { authorization: `Bearer ${idp.access_token}` },
  });
  if (!login.ok) throw new Error(`지글 로그인 ${login.status}`);

  const { access_token } = await login.json();
  await env.GIST.put('ziggleAccess', access_token, { expirationTtl: TOKEN_TTL });
  return access_token;
}

// orderBy=recent 가 없으면 2023년 글부터 온다 — 기본 정렬이 최신순이 아니다.
// 실제로 붙여보고 알았다. 30건이면 지글이 며칠치를 채울 만큼 올라와도 남는다.
const NOTICE_QUERY = '?orderBy=recent&limit=30';

const getNotices = (token) =>
  fetch(`${ZIGGLE_API}/notice${NOTICE_QUERY}`, {
    headers: { authorization: `Bearer ${token}` },
  });

export async function fetchZiggleNotices(env) {
  let token = await env.GIST.get('ziggleAccess');
  if (!token) token = await mintToken(env);

  let res = await getNotices(token);
  if (res.status === 401) {
    // 캐시된 토큰이 먼저 죽었다. 한 번만 새로 받아 다시 시도한다.
    res = await getNotices(await mintToken(env));
  }
  if (!res.ok) throw new Error(`지글 /notice ${res.status}`);

  const body = await res.json();
  // ponytail: 최신 30건만 읽는다. 30분 사이에 30건이 올라오면 놓친다.
  // 실제로 놓치면 그때 커서를 돈다.
  return Array.isArray(body?.list) ? body.list : [];
}

// -----------------------------------------------------------
//  공지 → 후보
//
//  여기는 네트워크를 안 탄다. 테스트가 그래서 쉽다.
// -----------------------------------------------------------

// 본문에 마크업이 섞여 온다. 태그를 벗기고 공백을 정리한다.
export const stripHtml = (s) =>
  String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * 지글 공지 하나를 승인 대기 후보로 바꾼다. 식사 행사가 아니면 null.
 *
 * @param {object} n  /notice 의 항목
 * @param {string} today  KST 기준 'YYYY-MM-DD'
 */
export function toCandidate(n, today) {
  if (!n?.id || !n?.title) return null;

  const body = stripHtml(n.content);
  // 학사공지는 제목만 있지만 지글은 본문이 함께 온다. 둘 다 보고 거른다.
  const searchable = `${n.title}\n${body}`;
  if (!looksLikeMeal(searchable)) return null;

  // 날짜 추측은 제목·본문에서만 뽑는다. 마감일(deadline)은 신청 마감이지
  // 행사 날짜가 아니다 — 섞으면 남의 달력에 엉뚱한 날이 박힌다.
  const guess = { date: pickDate(searchable, today), start: pickTime(searchable) };

  const deadline = n.currentDeadline || n.deadline;
  const text = [searchable, deadline && `신청 마감 ${String(deadline).slice(0, 10)}`]
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);

  return {
    id: `ziggle:${n.id}`,
    title: String(n.title).slice(0, 200),
    text,
    source: 'ziggle',
    sourceUrl: noticeUrl(n.id),
    guess,
  };
}
