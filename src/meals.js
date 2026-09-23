// ===========================================================
//  지꽁밥 — 순수 함수 모음
//
//  KV 도 fetch 도 건드리지 않는다. 전부 값을 받아 값을 돌려준다.
//  그래서 node --test 로 그냥 돌릴 수 있다.
// ===========================================================

// -----------------------------------------------------------
//  ICS (RFC 5545)
//
//  시간대를 VTIMEZONE 으로 싣지 않고 UTC 로 바꿔서 내보낸다.
//  한국은 서머타임이 없어 UTC+9 가 고정이라 변환이 안전하고,
//  VTIMEZONE 블록을 틀리게 쓰면 Outlook 이 통째로 거부한다.
// -----------------------------------------------------------
const KST_OFFSET_MIN = 9 * 60;

const pad = (n) => String(n).padStart(2, '0');

// 2026-09-25 + 12:00 (KST) → 20260925T030000Z
function utcStamp(date, hhmm) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm) - KST_OFFSET_MIN * 60 * 1000);
  return (
    `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}` +
    `T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}00Z`
  );
}

function nowStamp(now) {
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}

const ymd = (date) => date.replaceAll('-', '');

function nextDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}`;
}

function plusHour(hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  // 23시일 때는 00시가 아니라 23:59로 고정한다.
  // 아니면 DTEND 가 DTSTART 보다 앞이 되어 음수 길이 이벤트가 된다.
  if (hh >= 23) return '23:59';
  return `${pad(hh + 1)}:${pad(mm)}`;
}

// 역슬래시를 먼저 바꿔야 한다. 나중에 바꾸면 뒤에 넣은 역슬래시까지 또 바뀐다.
const esc = (s) =>
  String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

function vevent(m, now) {
  const out = [
    'BEGIN:VEVENT',
    `UID:${m.id}@gist-notice`,
    `DTSTAMP:${nowStamp(now)}`,
    `SEQUENCE:${m.seq ?? 0}`,
    `SUMMARY:${esc(m.title)}`,
  ];

  if (m.start) {
    out.push(`DTSTART:${utcStamp(m.date, m.start)}`);
    out.push(`DTEND:${utcStamp(m.date, m.end || plusHour(m.start))}`);
  } else {
    // 종일 이벤트의 DTEND 는 "끝나는 다음 날" 이다. 같은 날을 넣으면
    // 길이가 0인 이벤트가 되어 캘린더가 안 보여준다.
    out.push(`DTSTART;VALUE=DATE:${ymd(m.date)}`);
    out.push(`DTEND;VALUE=DATE:${nextDay(m.date)}`);
  }

  if (m.place) out.push(`LOCATION:${esc(m.place)}`);

  const desc = [
    m.host && `주최: ${m.host}`,
    m.note,
    m.signup?.url && `신청: ${m.signup.url}`,
    m.sourceUrl,
  ]
    .filter(Boolean)
    .join('\n');
  if (desc) out.push(`DESCRIPTION:${esc(desc)}`);

  // 취소한 이벤트를 피드에서 그냥 빼면 이미 구독한 캘린더에 유령으로 남는다.
  // CANCELLED 를 한동안 실어 보내야 구독자 쪽에서 지워진다.
  if (m.status === 'cancelled') out.push('STATUS:CANCELLED');

  out.push('END:VEVENT');
  return out;
}

export function toIcs(meals, now = new Date()) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//gist-notice//지꽁밥//KO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:지꽁밥',
    'X-WR-TIMEZONE:Asia/Seoul',
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ];
  for (const m of meals) lines.push(...vevent(m, now));
  lines.push('END:VCALENDAR');
  // ponytail: 75옥텟 줄 접기(line folding)는 안 한다. 제목이 아주 길면
  // 엄격한 파서가 투덜댈 수 있다. 실제로 깨지면 그때 접는다.
  return lines.join('\r\n');
}

// -----------------------------------------------------------
//  후보 거르기
//
//  음식 단어와 공짜 단어가 둘 다 있어야 걸린다. "무료" 하나로 거르면
//  무료 특강·무료 검진까지 전부 들어와 큐가 시끄러워진다.
//  거르기만 하고 판단은 안 한다 — 최종 판단은 승인 화면에서 사람이 한다.
// -----------------------------------------------------------
const FOOD = /중식|석식|간식|다과|도시락|피자|치킨|식사|점심|저녁|조식|간담회/;
const FREE = /무료|무상|제공|나눔|배부|선착순|참가비\s*없/;

export const looksLikeMeal = (text) => {
  const t = String(text ?? '');
  return FOOD.test(t) && FREE.test(t);
};

// -----------------------------------------------------------
//  날짜·시각 뽑기
//
//  공지 제목에서 뽑을 수 있는 만큼만 뽑는다. 못 뽑으면 빈 값을 주고
//  승인 화면에서 사람이 채운다. 억지로 맞히면 잘못된 날짜가 캘린더에
//  들어가는데, 그게 비어 있는 것보다 나쁘다.
// -----------------------------------------------------------
const RE_FULL = /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/;
const RE_MD = /(\d{1,2})\s*월\s*(\d{1,2})\s*일|(?<!\d)(\d{1,2})\/(\d{1,2})(?!\d)/;

export function pickDate(text, today) {
  const t = String(text ?? '');

  const full = t.match(RE_FULL);
  if (full) return `${full[1]}-${pad(full[2])}-${pad(full[3])}`;

  const md = t.match(RE_MD);
  if (!md) return '';
  const month = Number(md[1] ?? md[3]);
  const day = Number(md[2] ?? md[4]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';

  // 연도가 안 적힌 공지는 거의 올해 것이다. 다만 12월에 "1월 5일" 이라고
  // 쓰면 내년이다. 두 달 넘게 지난 날짜면 내년으로 본다.
  const year = Number(today.slice(0, 4));
  const guess = `${year}-${pad(month)}-${pad(day)}`;
  const gap = (Date.parse(today) - Date.parse(guess)) / 86400000;
  return gap > 60 ? `${year + 1}-${pad(month)}-${pad(day)}` : guess;
}

const RE_HM = /(\d{1,2}):(\d{2})/;
const RE_KO_TIME = /(오전|오후)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/;

export function pickTime(text) {
  const t = String(text ?? '');

  const hm = t.match(RE_HM);
  if (hm) return `${pad(hm[1])}:${hm[2]}`;

  const ko = t.match(RE_KO_TIME);
  if (!ko) return null;
  let hour = Number(ko[2]);
  // "오후 12시" 는 12시다. 12를 더하면 24시가 된다.
  if (ko[1] === '오후' && hour < 12) hour += 12;
  if (ko[1] === '오전' && hour === 12) hour = 0;
  if (hour > 23) return null;
  return `${pad(hour)}:${pad(ko[3] ?? 0)}`;
}

// -----------------------------------------------------------
//  정규화
//
//  후보에서 올라온 것이든 내가 손으로 넣은 것이든 같은 모양으로 만든다.
//  KV 에 제각각인 모양이 들어가면 ICS 생성과 화면 양쪽이 터진다.
// -----------------------------------------------------------
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TIME = /^\d{2}:\d{2}$/;
const time = (v) => (RE_TIME.test(String(v ?? '')) ? String(v) : null);

// signup.url 과 sourceUrl 은 화면에서 href 에 그대로 꽂힌다. escapeHtml 은
// <, >, " 같은 글자만 막을 뿐 javascript: 같은 스킴은 그대로 통과시킨다.
// 이 페이지는 관리자 토큰을 localStorage 에 두고 있어서, javascript: 링크를
// 관리자가 한 번 누르면 토큰이 그대로 새어나간다 — 장식이 아니라 저장
// 단계에서 막아야 할 보안 문제다. http/https 로 파싱되는 것만 통과시킨다.
const safeUrl = (v, max) => {
  const s = str(v, max);
  if (!s) return '';
  try {
    const { protocol } = new URL(s);
    return protocol === 'http:' || protocol === 'https:' ? s : '';
  } catch {
    return ''; // 상대경로거나 아예 URL 모양이 아니면 new URL 이 던진다
  }
};

export function normalize(input, prev = null) {
  const old = prev ?? {};
  const take = (key, fallback) => (input[key] !== undefined ? input[key] : old[key] ?? fallback);
  const signup = { ...(old.signup ?? {}), ...(input.signup ?? {}) };

  return {
    id: str(take('id', ''), 120),
    title: str(take('title', ''), 200),
    date: str(take('date', ''), 10),
    start: time(take('start', null)),
    end: time(take('end', null)),
    place: str(take('place', ''), 120),
    host: str(take('host', ''), 80),
    signup: {
      required: Boolean(signup.required),
      url: safeUrl(signup.url, 500),
      deadline: str(signup.deadline, 10),
      capacity: Number.isFinite(Number(signup.capacity)) && signup.capacity !== null && signup.capacity !== ''
        ? Number(signup.capacity)
        : null,
    },
    source: str(take('source', 'manual'), 20),
    sourceUrl: safeUrl(take('sourceUrl', ''), 500),
    note: str(take('note', ''), 1000),
    status: take('status', 'confirmed') === 'cancelled' ? 'cancelled' : 'confirmed',
    // 캘린더는 SEQUENCE 가 올라가야 변경을 받아들인다. 안 올리면 무시한다.
    seq: prev ? (Number(prev.seq) || 0) + 1 : 0,
    updatedAt: new Date().toISOString(),
  };
}

export function mealError(meal) {
  if (!meal.id) return 'id 가 필요합니다';
  if (!meal.title) return '제목이 필요합니다';
  if (!RE_DATE.test(meal.date)) return '날짜는 YYYY-MM-DD 여야 합니다';
  return null;
}
