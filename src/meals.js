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
  return `${pad((hh + 1) % 24)}:${pad(mm)}`;
}

// 역슬래시를 먼저 바꿔야 한다. 나중에 바꾸면 뒤에 넣은 역슬래시까지 또 바뀐다.
const esc = (s) =>
  String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
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
