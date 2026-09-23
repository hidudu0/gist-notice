# 지꽁밥 0·1단계 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 무료 식사 행사를 앱의 "지꽁밥" 탭과 캘린더 구독(ICS)으로 내보내고, 학사공지에서 후보를 자동 적재한다.

**Architecture:** 순수 함수만 모은 `src/meals.js` 를 새로 만들고(필터·날짜 파싱·ICS 생성), `src/worker.js` 에 라우트 6개를 붙인다. KV 키는 `mealq:` (후보) / `meal:` (확정) / `meals` (읽기 캐시) 세 갈래. 기존 공지 경로는 건드리지 않는다.

**Tech Stack:** Cloudflare Workers (모듈 워커), KV, 바닐라 JS PWA, `node --test`

**Spec:** `docs/superpowers/specs/2026-09-23-zigongbap-design.md`

## Global Constraints

- Node/브라우저 표준 API 만 쓴다. `require`, `fs`, `http`, Node 전용 `crypto` 금지 — Workers 런타임에서 죽는다
- 새 npm 의존성을 추가하지 않는다
- ES 모듈. `package.json` 에 `"type": "module"`
- 테스트는 `node --test` + `node:assert/strict`. 프레임워크 추가 금지
- 관리자 인증은 기존 `authed(req, env)` 와 `x-admin-token` 헤더를 그대로 쓴다. 새로 만들지 않는다
- 시간대는 Asia/Seoul 고정(서머타임 없음). ICS 는 VTIMEZONE 대신 UTC 로 내보낸다
- 주석과 커밋 메시지는 한국어. 기존 파일 톤(왜 이렇게 했는지를 적는다)을 따른다
- 사용자 입력을 `innerHTML` 에 직접 넣지 않는다. 기존 `escapeHtml()` 을 쓴다

---

### Task 1: `src/meals.js` — ICS 생성

**Files:**
- Create: `src/meals.js`
- Test: `test/meals-ics.test.js`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `toIcs(meals: Meal[], now: Date): string`
  - `Meal` 모양: `{ id, title, date, start, end, place, host, signup:{required,url,deadline,capacity}, source, sourceUrl, note, status, seq, updatedAt }`
    - `date` 는 `'YYYY-MM-DD'`, `start`/`end` 는 `'HH:MM'` 또는 `null`
    - `status` 는 `'confirmed'` 또는 `'cancelled'`
    - `seq` 는 0부터 시작하는 정수

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/meals-ics.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toIcs } from '../src/meals.js';

const NOW = new Date('2026-09-23T00:00:00Z');

const 기본 = {
  id: 'manual:1', title: '무료 점심', date: '2026-09-25',
  start: null, end: null, place: '학생회관', host: '총학생회',
  signup: { required: false, url: '', deadline: '', capacity: null },
  source: 'manual', sourceUrl: '', note: '',
  status: 'confirmed', seq: 0, updatedAt: '2026-09-23T00:00:00.000Z',
};

test('봉투와 달력 헤더가 들어간다', () => {
  const ics = toIcs([기본], NOW);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nEND:VCALENDAR$/);
  assert.match(ics, /\r\nX-WR-CALNAME:지꽁밥\r\n/);
  assert.match(ics, /\r\nVERSION:2\.0\r\n/);
});

test('줄바꿈은 CRLF 다', () => {
  assert.ok(!toIcs([기본], NOW).includes('\n\n'));
  assert.equal(toIcs([기본], NOW).split('\r\n').some((l) => l.includes('\n')), false);
});

test('시간이 없으면 종일 이벤트이고 DTEND 는 다음 날이다', () => {
  const ics = toIcs([기본], NOW);
  assert.match(ics, /DTSTART;VALUE=DATE:20260925/);
  assert.match(ics, /DTEND;VALUE=DATE:20260926/);
});

test('시간이 있으면 KST 를 UTC 로 바꿔 내보낸다', () => {
  const m = { ...기본, start: '12:00', end: '13:30' };
  const ics = toIcs([m], NOW);
  assert.match(ics, /DTSTART:20260925T030000Z/);
  assert.match(ics, /DTEND:20260925T043000Z/);
});

test('오전 9시 이전은 전날 UTC 로 넘어간다', () => {
  const m = { ...기본, start: '08:00', end: '09:00' };
  const ics = toIcs([m], NOW);
  assert.match(ics, /DTSTART:20260924T230000Z/);
  assert.match(ics, /DTEND:20260925T000000Z/);
});

test('끝 시각이 없으면 한 시간짜리로 본다', () => {
  const ics = toIcs([{ ...기본, start: '12:00' }], NOW);
  assert.match(ics, /DTEND:20260925T040000Z/);
});

test('UID 와 SEQUENCE 가 들어간다', () => {
  const ics = toIcs([{ ...기본, seq: 3 }], NOW);
  assert.match(ics, /UID:manual:1@gist-notice/);
  assert.match(ics, /SEQUENCE:3/);
});

test('취소된 이벤트는 빠지지 않고 STATUS:CANCELLED 로 남는다', () => {
  const ics = toIcs([{ ...기본, status: 'cancelled' }], NOW);
  assert.match(ics, /UID:manual:1@gist-notice/);
  assert.match(ics, /STATUS:CANCELLED/);
});

test('쉼표·세미콜론·역슬래시·줄바꿈을 이스케이프한다', () => {
  const m = { ...기본, title: '피자, 치킨; 무료\\다', note: '1층\n2층' };
  const ics = toIcs([m], NOW);
  assert.match(ics, /SUMMARY:피자\\, 치킨\; 무료\\\\다/);
  assert.match(ics, /DESCRIPTION:.*1층\\n2층/);
});

test('장소와 설명이 비면 그 줄을 아예 안 넣는다', () => {
  const m = { ...기본, place: '', host: '', note: '', sourceUrl: '' };
  const ics = toIcs([m], NOW);
  assert.ok(!ics.includes('LOCATION:'));
  assert.ok(!ics.includes('DESCRIPTION:'));
});

test('이벤트가 없어도 빈 달력을 돌려준다', () => {
  const ics = toIcs([], NOW);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.ok(!ics.includes('BEGIN:VEVENT'));
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/meals.js'`

- [ ] **Step 3: 최소 구현을 쓴다**

`src/meals.js`:

```js
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
  // 자정을 넘기면 같은 날짜에 붙는 DTEND 가 DTSTART 보다 앞서게 된다.
  // 길이가 음수인 이벤트는 캘린더가 조용히 무시한다. 그날 끝으로 자른다.
  return hh >= 23 ? '23:59' : `${pad(hh + 1)}:${pad(mm)}`;
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
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test`
Expected: PASS — 기존 13건 + 새 11건

- [ ] **Step 5: 커밋한다**

```bash
git add src/meals.js test/meals-ics.test.js
git commit -m "지꽁밥: 이벤트를 ICS 달력으로 내보낸다"
```

---

### Task 2: `src/meals.js` — 키워드 필터와 날짜 파싱

**Files:**
- Modify: `src/meals.js` (아래에 덧붙인다)
- Test: `test/meals-pick.test.js`

**Interfaces:**
- Consumes: Task 1 의 `src/meals.js`
- Produces:
  - `looksLikeMeal(text: string): boolean`
  - `pickDate(text: string, today: string): string` — `'YYYY-MM-DD'` 또는 `''`
  - `pickTime(text: string): string | null` — `'HH:MM'` 또는 `null`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/meals-pick.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeMeal, pickDate, pickTime } from '../src/meals.js';

test('음식 단어와 공짜 단어가 둘 다 있어야 걸린다', () => {
  assert.equal(looksLikeMeal('[총학] 무료 점심 나눔'), true);
  assert.equal(looksLikeMeal('학생 간담회 중식 제공'), true);
  assert.equal(looksLikeMeal('선착순 도시락 배부'), true);
  assert.equal(looksLikeMeal('다과 무상 제공'), true);
});

test('한쪽만 있으면 안 걸린다', () => {
  assert.equal(looksLikeMeal('[학사] 무료 특강 안내'), false);
  assert.equal(looksLikeMeal('국가장학금 선착순 신청'), false);
  assert.equal(looksLikeMeal('학생식당 점심 메뉴 변경'), false);
  assert.equal(looksLikeMeal('졸업사정 안내'), false);
});

test('빈 값도 안전하다', () => {
  assert.equal(looksLikeMeal(''), false);
  assert.equal(looksLikeMeal(null), false);
});

test('YYYY-MM-DD 와 YYYY.MM.DD 를 읽는다', () => {
  assert.equal(pickDate('행사는 2026-09-25 입니다', '2026-09-23'), '2026-09-25');
  assert.equal(pickDate('행사는 2026.09.25 입니다', '2026-09-23'), '2026-09-25');
  assert.equal(pickDate('행사는 2026/9/5 입니다', '2026-09-23'), '2026-09-05');
});

test('연도가 없으면 올해로 본다', () => {
  assert.equal(pickDate('9월 25일(목) 점심', '2026-09-23'), '2026-09-25');
  assert.equal(pickDate('10/2 저녁', '2026-09-23'), '2026-10-02');
});

test('연도 없는 날짜가 두 달 넘게 지났으면 내년으로 본다', () => {
  assert.equal(pickDate('1월 5일 신년회', '2026-12-20'), '2027-01-05');
});

test('연도 없는 날짜가 조금 지난 정도면 올해로 둔다', () => {
  assert.equal(pickDate('9월 20일 행사', '2026-09-23'), '2026-09-20');
});

test('날짜가 없으면 빈 문자열', () => {
  assert.equal(pickDate('무료 점심 제공', '2026-09-23'), '');
  assert.equal(pickDate('', '2026-09-23'), '');
});

test('시각을 읽는다', () => {
  assert.equal(pickTime('12:00 부터'), '12:00');
  assert.equal(pickTime('오후 12시 30분'), '12:30');
  assert.equal(pickTime('오후 1시'), '13:00');
  assert.equal(pickTime('오전 11시'), '11:00');
  assert.equal(pickTime('18시'), '18:00');
});

test('시각이 없으면 null', () => {
  assert.equal(pickTime('무료 점심'), null);
  assert.equal(pickTime(''), null);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test`
Expected: FAIL — `looksLikeMeal is not a function`

- [ ] **Step 3: 최소 구현을 쓴다**

`src/meals.js` 맨 아래에 덧붙인다:

```js
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
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test`
Expected: PASS — 전부 통과

- [ ] **Step 5: 커밋한다**

```bash
git add src/meals.js test/meals-pick.test.js
git commit -m "지꽁밥: 공지에서 식사 행사 후보와 날짜·시각을 뽑는다"
```

---

### Task 3: `src/meals.js` — 이벤트 정규화

**Files:**
- Modify: `src/meals.js`
- Test: `test/meals-normalize.test.js`

**Interfaces:**
- Consumes: Task 1·2 의 `src/meals.js`
- Produces:
  - `normalize(input: object, prev: Meal | null): Meal`
  - `mealError(meal: Meal): string | null` — 문제가 있으면 사람이 읽을 메시지, 없으면 `null`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/meals-normalize.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, mealError } from '../src/meals.js';

test('빠진 칸을 기본값으로 채운다', () => {
  const m = normalize({ id: 'manual:1', title: '무료 점심', date: '2026-09-25' }, null);
  assert.equal(m.start, null);
  assert.equal(m.place, '');
  assert.equal(m.status, 'confirmed');
  assert.equal(m.seq, 0);
  assert.deepEqual(m.signup, { required: false, url: '', deadline: '', capacity: null });
  assert.match(m.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('고칠 때마다 seq 가 올라간다', () => {
  const first = normalize({ id: 'manual:1', title: 'A', date: '2026-09-25' }, null);
  const second = normalize({ title: 'B' }, first);
  assert.equal(second.seq, 1);
  assert.equal(second.id, 'manual:1');
  assert.equal(second.title, 'B');
  assert.equal(second.date, '2026-09-25'); // 안 준 칸은 이전 값을 지킨다
});

test('status 는 두 값만 허용한다', () => {
  assert.equal(normalize({ id: 'a', title: 'A', date: '2026-09-25', status: '아무거나' }, null).status, 'confirmed');
  assert.equal(normalize({ id: 'a', title: 'A', date: '2026-09-25', status: 'cancelled' }, null).status, 'cancelled');
});

test('너무 긴 값은 자른다', () => {
  const m = normalize({ id: 'a', title: 'ㄱ'.repeat(500), date: '2026-09-25' }, null);
  assert.equal(m.title.length, 200);
});

test('제목이 없으면 문제를 알려준다', () => {
  assert.match(mealError(normalize({ id: 'a', date: '2026-09-25' }, null)), /제목/);
});

test('날짜 모양이 틀리면 문제를 알려준다', () => {
  assert.match(mealError(normalize({ id: 'a', title: 'A', date: '9월 25일' }, null)), /날짜/);
  assert.match(mealError(normalize({ id: 'a', title: 'A', date: '' }, null)), /날짜/);
});

test('id 가 없으면 문제를 알려준다', () => {
  assert.match(mealError(normalize({ title: 'A', date: '2026-09-25' }, null)), /id/);
});

test('멀쩡한 이벤트는 문제가 없다', () => {
  const m = normalize({ id: 'manual:1', title: 'A', date: '2026-09-25' }, null);
  assert.equal(mealError(m), null);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test`
Expected: FAIL — `normalize is not a function`

- [ ] **Step 3: 최소 구현을 쓴다**

`src/meals.js` 맨 아래에 덧붙인다:

```js
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
      url: str(signup.url, 500),
      deadline: str(signup.deadline, 10),
      capacity: Number.isFinite(Number(signup.capacity)) && signup.capacity !== null && signup.capacity !== ''
        ? Number(signup.capacity)
        : null,
    },
    source: str(take('source', 'manual'), 20),
    sourceUrl: str(take('sourceUrl', ''), 500),
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
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 커밋한다**

```bash
git add src/meals.js test/meals-normalize.test.js
git commit -m "지꽁밥: 이벤트를 한 모양으로 정규화하고 검사한다"
```

---

### Task 4: 공개 라우트 — `/api/meals`, `/api/meals.ics`

**Files:**
- Modify: `src/worker.js`

**Interfaces:**
- Consumes: `toIcs` (Task 1)
- Produces:
  - KV `meals` — 확정 이벤트 배열(취소분 포함), 날짜 오름차순
  - `GET /api/meals` → 취소되지 않은 이벤트만 JSON 배열
  - `GET /api/meals.ics` → `text/calendar`

- [ ] **Step 1: 라우트를 붙인다**

`src/worker.js` 상단 import 에 추가:

```js
import { toIcs } from './meals.js';
```

`fetch()` 안, `/api/meta` 블록 바로 다음에 넣는다:

```js
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
```

- [ ] **Step 2: 문법을 확인한다**

Run: `node --check src/worker.js && npm test`
Expected: 문법 OK, 테스트 전부 통과

- [ ] **Step 3: 로컬에서 실제로 불러본다**

Run: `npx wrangler dev --port 8787` 를 따로 띄워두고, 다른 창에서

```bash
curl -s http://127.0.0.1:8787/api/meals
curl -s -D- -o /dev/null http://127.0.0.1:8787/api/meals.ics
```

Expected: 각각 `[]` 와 `HTTP/1.1 200` + `content-type: text/calendar; charset=utf-8`

- [ ] **Step 4: 커밋한다**

```bash
git add src/worker.js
git commit -m "지꽁밥: 목록과 달력 구독 엔드포인트"
```

---

### Task 5: 관리 라우트 — 후보 큐와 승인

**Files:**
- Modify: `src/worker.js`

**Interfaces:**
- Consumes: `normalize`, `mealError` (Task 3)
- Produces:
  - `refreshMeals(env): Promise<Meal[]>` — `meal:` 키를 모아 `meals` 캐시를 다시 쓴다. 취소된 지 30일 지난 것은 KV 에서 지운다
  - `GET /api/meals/queue` → `{ id, title, text, source, sourceUrl, receivedAt, guess:{date,start} }[]`
  - `POST /api/meals/queue` → `{ ok: true, id }`
  - `POST /api/meals` → `{ ok: true, meal }`
  - `DELETE /api/meals/<id>` → `{ ok: true }`

- [ ] **Step 1: 도우미와 라우트를 붙인다**

`src/worker.js` import 를 고친다:

```js
import { toIcs, normalize, mealError, pickDate, pickTime } from './meals.js';
```

`dropIfGone` 아래에 도우미를 넣는다:

```js
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
```

`/api/broadcast` 블록 바로 앞에 라우트를 넣는다:

```js
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

      const id = decodeURIComponent(pathname.slice('/api/meals/'.length));
      const prev = await env.GIST.get(`meal:${id}`, 'json');
      if (!prev) return json({ error: '없는 이벤트입니다' }, 404);

      await env.GIST.put(`meal:${id}`, JSON.stringify(normalize({ status: 'cancelled' }, prev)));
      await refreshMeals(env);
      return json({ ok: true });
    }
```

- [ ] **Step 2: 라우트 순서를 확인한다**

`/api/meals/queue` 블록이 `pathname.startsWith('/api/meals/')` 블록보다 **위**에 있어야 한다. 아래에 두면 DELETE 가 아닌 요청은 안 걸리지만, 순서가 바뀌면 읽기 어려워진다.

Run: `node --check src/worker.js && npm test`
Expected: 문법 OK, 테스트 통과

- [ ] **Step 3: 로컬에서 한 바퀴 돌린다**

`.dev.vars` 에 `ADMIN_TOKEN` 이 이미 있다. `npx wrangler dev --port 8787` 을 띄우고:

```bash
T=$(grep '^ADMIN_TOKEN=' .dev.vars | cut -d= -f2-)
H="x-admin-token: $T"

# 인증 없이는 막힌다
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8787/api/meals

# 후보 적재 → 조회
curl -s -X POST -H "$H" -H 'content-type: application/json' \
  -d '{"id":"manual:t1","title":"무료 점심","text":"9월 25일 12:00 학생회관 무료 점심 제공"}' \
  http://127.0.0.1:8787/api/meals/queue
curl -s -H "$H" http://127.0.0.1:8787/api/meals/queue

# 승인 → 목록·달력에 반영
curl -s -X POST -H "$H" -H 'content-type: application/json' \
  -d '{"id":"manual:t1","title":"무료 점심","date":"2026-09-25","start":"12:00","place":"학생회관"}' \
  http://127.0.0.1:8787/api/meals
curl -s http://127.0.0.1:8787/api/meals
curl -s http://127.0.0.1:8787/api/meals.ics

# 취소 → 목록에서 빠지고 달력에는 CANCELLED 로 남는다
curl -s -X DELETE -H "$H" http://127.0.0.1:8787/api/meals/manual:t1
curl -s http://127.0.0.1:8787/api/meals
curl -s http://127.0.0.1:8787/api/meals.ics | grep STATUS
```

Expected: 첫 줄 `401`, 적재 후 큐에 1건(`guess.date` 가 `2026-09-25`), 승인 후 `/api/meals` 에 1건, 취소 후 `/api/meals` 는 `[]` 이고 ICS 에 `STATUS:CANCELLED`

- [ ] **Step 4: 커밋한다**

```bash
git add src/worker.js
git commit -m "지꽁밥: 후보 큐와 승인·취소 엔드포인트"
```

---

### Task 6: 크론이 학사공지에서 후보를 적재한다

**Files:**
- Modify: `src/worker.js` (`checkBoard` 안)

**Interfaces:**
- Consumes: `looksLikeMeal`, `pickDate`, `pickTime` (Task 2), `QUEUE_TTL` (Task 5)
- Produces: `queueFromNotices(items, board, env): Promise<number>` — 새로 넣은 후보 수

- [ ] **Step 1: 도우미를 만든다**

import 에 `looksLikeMeal` 을 추가하고, `refreshMeals` 아래에 넣는다:

```js
// 크론이 이미 파싱해둔 공지에서 식사 행사 후보만 골라 큐에 넣는다.
// 게시판을 다시 긁지 않으므로 추가 요청이 0이다.
async function queueFromNotices(items, board, env) {
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  let added = 0;

  for (const c of items) {
    if (!looksLikeMeal(c.title)) continue;

    const id = `gist:${c.no}`;
    // 이미 승인했거나 이미 큐에 있으면 건드리지 않는다.
    // 내가 승인 화면에서 고쳐둔 값을 크론이 덮어쓰면 안 된다.
    if (await env.GIST.get(`meal:${id}`)) continue;
    if (await env.GIST.get(`mealq:${id}`)) continue;

    await env.GIST.put(
      `mealq:${id}`,
      JSON.stringify({
        id,
        title: c.title,
        text: c.title,
        source: 'gist',
        sourceUrl: detailUrl(board, c.no),
        receivedAt: new Date().toISOString(),
        // 게시 날짜(c.date)를 행사 날짜로 쓰지 않는다. 둘은 다르고, 틀린 날짜가
        // 달력에 들어가는 것이 빈칸보다 나쁘다.
        guess: { date: pickDate(c.title, today), start: pickTime(c.title) },
      }),
      { expirationTtl: QUEUE_TTL },
    );
    added += 1;
  }

  if (added > 0) console.log(`지꽁밥 후보 ${added}건 적재`);
  return added;
}
```

- [ ] **Step 2: 크론에 연결한다**

`checkBoard` 안, `await mergeCategories(items, env);` 바로 다음 줄에 넣는다:

```js
  await queueFromNotices(items, board, env);
```

- [ ] **Step 3: 확인한다**

Run: `node --check src/worker.js && npm test`
Expected: 문법 OK, 테스트 통과

`npx wrangler dev --port 8787` 을 띄우고:

```bash
T=$(grep '^ADMIN_TOKEN=' .dev.vars | cut -d= -f2-)
curl -s -X POST -H "x-admin-token: $T" http://127.0.0.1:8787/api/run
curl -s -H "x-admin-token: $T" http://127.0.0.1:8787/api/meals/queue
```

Expected: `/api/run` 이 `{"fresh":...,"sent":...}` 를 돌려주고, 큐에는 실제 게시판에서 걸린 후보가 들어 있다(0건일 수도 있다 — 그러면 `looksLikeMeal('무료 점심 제공')` 이 `true` 인지만 확인하고 넘어간다)

- [ ] **Step 4: 커밋한다**

```bash
git add src/worker.js
git commit -m "지꽁밥: 크론이 학사공지에서 식사 행사 후보를 적재한다"
```

---

### Task 7: 화면 — 탭

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: 없음
- Produces: `showTab(name: 'notice' | 'meals')` — 탭을 바꾸고 `localStorage.tab` 에 남긴다

- [ ] **Step 1: 마크업을 넣는다**

`public/index.html` 에서 현재 화면 전체(`panel` 부터 `list` 까지)를 `<section id="tab-notice">` 로 감싸고, 그 앞에 탭 줄을, 뒤에 빈 지꽁밥 화면을 넣는다:

```html
  <nav class="tabs">
    <button class="tab on" data-tab="notice">공지</button>
    <button class="tab" data-tab="meals">지꽁밥</button>
  </nav>

  <section id="tab-notice">
    <!-- 지금 있는 내용 그대로 -->
  </section>

  <section id="tab-meals" hidden>
    <div id="meals"><div class="msg">불러오는 중…</div></div>
  </section>
```

- [ ] **Step 2: 스타일을 넣는다**

기존 `<style>` 안, `.msg` 규칙 근처에 넣는다:

```css
  .tabs { display:flex; gap:4px; margin:0 0 18px; }
  .tab {
    flex:1; padding:10px; font-size:14px; font-weight:600;
    color:var(--muted); background:none; border:none;
    border-bottom:2px solid transparent; cursor:pointer;
  }
  .tab.on { color:var(--ink); border-bottom-color:var(--ink); }
```

- [ ] **Step 3: 전환 코드를 넣는다**

`<script>` 안, `render()` 정의 근처에 넣는다:

```js
// -----------------------------------------------------------
//  탭
//
//  보던 탭을 기억한다. 지꽁밥을 보려고 앱을 연 사람이 매번
//  공지 탭부터 지나가지 않게.
// -----------------------------------------------------------
function showTab(name) {
  for (const b of document.querySelectorAll('.tab')) {
    b.classList.toggle('on', b.dataset.tab === name);
  }
  document.getElementById('tab-notice').hidden = name !== 'notice';
  document.getElementById('tab-meals').hidden = name !== 'meals';
  try { localStorage.setItem('tab', name); } catch { /* 사파리 비공개 모드 */ }
  if (name === 'meals') loadMeals();
}

for (const b of document.querySelectorAll('.tab')) {
  b.onclick = () => showTab(b.dataset.tab);
}
```

그리고 스크립트 **맨 끝**, 기존 `start(); loadMeta(); loadList();` **뒤에** 넣는다.
앞에 두면 안 된다 — `showTab` 이 던지면 뒤따르는 세 줄이 통째로 안 돈다:

```js
start();
loadMeta();
loadList();

// 보던 탭 복원은 맨 마지막이다. 앞에 두면 showTab 안에서 예외가 났을 때
// 나머지 초기화가 통째로 멈춰 공지 화면까지 죽는다.
let savedTab = 'notice';
try { savedTab = localStorage.getItem('tab') || 'notice'; } catch { /* 무시 */ }
showTab(savedTab);
```

- [ ] **Step 4: 확인한다**

Run: `npx wrangler dev --port 8787` 후 브라우저로 `http://127.0.0.1:8787` 을 연다
Expected: 탭 두 개가 보이고, 전환되고, 새로고침해도 보던 탭이 유지된다. 공지 탭은 예전과 똑같이 동작한다

(`loadMeals` 는 아직 없으므로 콘솔에 에러가 난다. 다음 Task 에서 만든다.)

- [ ] **Step 5: 커밋한다**

```bash
git add public/index.html
git commit -m "지꽁밥: 공지·지꽁밥 탭"
```

---

### Task 8: 화면 — 지꽁밥 목록과 캘린더 구독

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `GET /api/meals` (Task 4), `escapeHtml` (기존)
- Produces: `loadMeals()`

- [ ] **Step 1: 목록 코드를 넣는다**

`loadList()` 아래에 넣는다:

```js
// -----------------------------------------------------------
//  지꽁밥
//
//  지난 행사는 숨긴다. 오늘 것은 남긴다 — 점심이 아직 안 지났을 수 있다.
// -----------------------------------------------------------
const mealsEl = document.getElementById('meals');

async function loadMeals() {
  try {
    const res = await fetch('/api/meals');
    if (!res.ok) throw new Error('응답 ' + res.status);
    const all = await res.json();

    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const upcoming = all.filter((m) => m.date >= today);

    const feed = `${location.origin}/api/meals.ics`;
    const head = `<a class="ghost-link" href="webcal://${location.host}/api/meals.ics">캘린더에 추가</a>
      <div class="msg">안 되면 이 주소를 캘린더 앱에 붙여넣으세요<br>${escapeHtml(feed)}</div>`;

    if (upcoming.length === 0) {
      mealsEl.innerHTML = `${head}<div class="msg">예정된 행사가 없습니다</div>`;
      return;
    }

    mealsEl.innerHTML = head + upcoming.map(mealCard).join('');
  } catch (err) {
    console.error('지꽁밥 불러오기 실패', err);
    const why = navigator.onLine ? err.message : '오프라인';
    mealsEl.innerHTML = `<div class="msg bad">불러오지 못했습니다 (${escapeHtml(why)})<br>
      <button class="ghost" id="meals-retry">다시 시도</button></div>`;
    document.getElementById('meals-retry').onclick = loadMeals;
  }
}

function mealCard(m) {
  const when = m.start ? `${m.date} ${m.start}` : m.date;
  const where = m.place ? ` · ${escapeHtml(m.place)}` : '';
  const signup = m.signup?.url
    ? `<a class="ghost-link" href="${escapeHtml(m.signup.url)}" target="_blank" rel="noopener">신청하기</a>`
    : '';
  const src = m.sourceUrl
    ? `<a class="ghost-link" href="${escapeHtml(m.sourceUrl)}" target="_blank" rel="noopener">원문</a>`
    : '';
  return `<article class="meal">
    <h3>${escapeHtml(m.title)}</h3>
    <div class="meal-meta">${escapeHtml(when)}${where}</div>
    ${m.note ? `<p class="meal-note">${escapeHtml(m.note)}</p>` : ''}
    <div class="meal-links">${signup}${src}</div>
  </article>`;
}
```

- [ ] **Step 2: 스타일을 넣는다**

```css
  .meal { padding:14px 0; border-bottom:1px solid var(--line); }
  .meal h3 { margin:0 0 6px; font-size:15px; font-weight:600; }
  .meal-meta { font-size:13px; color:var(--muted); }
  .meal-note { margin:8px 0 0; font-size:13px; color:var(--muted); }
  .meal-links { display:flex; gap:12px; margin-top:8px; }
  .ghost-link { font-size:13px; color:var(--muted); text-decoration:underline; }
```

`--line` 이 기존 `<style>` 의 `:root` 에 없으면 목록 구분선에 쓰인 색을 그대로 가져다 쓴다.

- [ ] **Step 3: 확인한다**

`wrangler dev` 상태에서 Task 5 의 curl 로 이벤트를 하나 넣고 지꽁밥 탭을 연다.

Expected: 카드가 보이고, "캘린더에 추가" 를 누르면 캘린더 앱이 뜬다. 서버를 끄고 새로고침하면 "다시 시도" 버튼이 있는 에러가 보인다

- [ ] **Step 4: 커밋한다**

```bash
git add public/index.html
git commit -m "지꽁밥: 행사 목록과 캘린더 구독 버튼"
```

---

### Task 9: 화면 — 승인 큐와 입력 폼 (관리자만)

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `GET/POST /api/meals/queue`, `POST /api/meals`, `DELETE /api/meals/:id` (Task 4·5), `adminHeaders()` (기존)
- Produces: `loadQueue()`, `saveMeal(fields)`

- [ ] **Step 1: 마크업 자리를 만든다**

`#tab-meals` 안, `#meals` 위에 넣는다:

```html
    <div id="admin" hidden>
      <h2 class="admin-h">승인 대기</h2>
      <div id="queue"></div>
      <h2 class="admin-h">직접 추가</h2>
      <form id="meal-form" class="meal-form">
        <input name="title" placeholder="제목" required>
        <input name="date" placeholder="YYYY-MM-DD" required>
        <input name="start" placeholder="HH:MM (없으면 비움)">
        <input name="place" placeholder="장소">
        <input name="signupUrl" placeholder="신청 링크">
        <input name="note" placeholder="메모">
        <button type="submit">추가</button>
      </form>
      <div class="msg" id="admin-msg"></div>
    </div>
```

- [ ] **Step 2: 스타일을 넣는다**

```css
  .admin-h { margin:18px 0 8px; font-size:13px; color:var(--muted); font-weight:600; }
  .meal-form { display:flex; flex-direction:column; gap:8px; }
  .meal-form input {
    padding:10px; font-size:14px; color:var(--ink);
    background:none; border:1px solid var(--line); border-radius:8px;
  }
  .queue-item { padding:12px 0; border-bottom:1px solid var(--line); }
  .queue-item .meal-links { margin-top:6px; }
```

- [ ] **Step 3: 코드를 넣는다**

`loadMeals` 아래에 넣는다:

```js
// -----------------------------------------------------------
//  관리자 — 승인 큐
//
//  adminToken 이 있어야 보인다. 탭 자체는 누구나 보지만, 무엇을 공개할지는
//  내가 정한다. 남의 폰에 내 메일에서 나온 게 그냥 나가면 안 된다.
// -----------------------------------------------------------
const adminEl = document.getElementById('admin');
const queueEl = document.getElementById('queue');
const adminMsg = document.getElementById('admin-msg');

const isAdmin = () => Boolean(localStorage.getItem('adminToken'));

async function loadQueue() {
  if (!isAdmin()) return;
  adminEl.hidden = false;
  try {
    const res = await fetch('/api/meals/queue', { headers: adminHeaders() });
    if (!res.ok) throw new Error('응답 ' + res.status);
    const items = await res.json();
    queueEl.innerHTML = items.length
      ? items.map(queueCard).join('')
      : '<div class="msg">대기 중인 후보가 없습니다</div>';
    for (const b of queueEl.querySelectorAll('[data-approve]')) {
      b.onclick = () => approve(items.find((i) => i.id === b.dataset.approve));
    }
  } catch (err) {
    console.error('후보 큐 불러오기 실패', err);
    queueEl.innerHTML = '<div class="msg bad">후보를 불러오지 못했습니다</div>';
  }
}

function queueCard(c) {
  const guess = [c.guess?.date, c.guess?.start].filter(Boolean).join(' ') || '날짜 못 찾음';
  return `<div class="queue-item">
    <div>${escapeHtml(c.title)}</div>
    <div class="meal-meta">${escapeHtml(c.source)} · ${escapeHtml(guess)}</div>
    <div class="meal-links">
      <button class="ghost" data-approve="${escapeHtml(c.id)}">폼에 채우기</button>
    </div>
  </div>`;
}

// 승인은 곧바로 공개하지 않고 폼에 채운다. 뽑아낸 값이 맞는지 내가 보고 고친다.
function approve(c) {
  if (!c) return;
  const f = document.getElementById('meal-form');
  // f.title 은 입력칸이 아니라 HTMLElement.title 문자열이다.
  // 이름이 겹치는 칸이 있으므로 elements 를 거쳐야 한다.
  f.elements.title.value = c.title;
  f.elements.date.value = c.guess?.date || '';
  f.elements.start.value = c.guess?.start || '';
  f.elements.note.value = '';
  f.dataset.id = c.id;
  f.dataset.source = c.source;
  f.dataset.sourceUrl = c.sourceUrl || '';
  f.scrollIntoView({ behavior: 'smooth' });
}

document.getElementById('meal-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    id: f.dataset.id || `manual:${Date.now()}`,
    title: f.elements.title.value,
    date: f.elements.date.value,
    start: f.elements.start.value || null,
    place: f.elements.place.value,
    note: f.elements.note.value,
    source: f.dataset.source || 'manual',
    sourceUrl: f.dataset.sourceUrl || '',
    signup: {
      required: Boolean(f.elements.signupUrl.value),
      url: f.elements.signupUrl.value,
    },
  };

  adminMsg.textContent = '저장 중…';
  adminMsg.className = 'msg';
  try {
    const res = await fetch('/api/meals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders() },
      body: JSON.stringify(body),
    });
    const info = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(info.error || `응답 ${res.status}`);
    adminMsg.textContent = '저장했습니다';
    adminMsg.className = 'msg good';
    f.reset();
    delete f.dataset.id;
    delete f.dataset.source;
    delete f.dataset.sourceUrl;
    loadMeals();
    loadQueue();
  } catch (err) {
    console.error('지꽁밥 저장 실패', err);
    adminMsg.textContent = '실패: ' + err.message;
    adminMsg.className = 'msg bad';
  }
};
```

`showTab` 의 `if (name === 'meals') loadMeals();` 를 고친다:

```js
  if (name === 'meals') { loadMeals(); loadQueue(); }
```

- [ ] **Step 4: 확인한다**

`wrangler dev` 상태에서 `http://127.0.0.1:8787/#admin=<ADMIN_TOKEN>` 으로 한 번 열어 토큰을 심고, 지꽁밥 탭을 연다.

Expected:
- 토큰이 없는 창에서는 승인 큐와 폼이 아예 안 보인다
- 토큰이 있으면 큐가 보이고, "폼에 채우기" 를 누르면 값이 채워지고, 추가하면 아래 목록에 바로 뜬다
- 제목 없이 보내면 "실패: 제목이 필요합니다" 가 뜬다

- [ ] **Step 5: 커밋한다**

```bash
git add public/index.html
git commit -m "지꽁밥: 승인 큐와 직접 추가 폼"
```

---

### Task 10: 배포와 실제 확인

**Files:** 없음 (문서만)

- [ ] **Step 1: 전부 돌려본다**

Run: `npm test && node --check src/worker.js && node --check src/meals.js`
Expected: 전부 통과

- [ ] **Step 2: 배포한다**

Run: `npm run deploy`
Expected: `Deployed gist-notice triggers` 와 버전 ID

- [ ] **Step 3: 운영에서 확인한다**

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" https://gist-notice.dudu0.workers.dev/api/meals.ics
curl -s https://gist-notice.dudu0.workers.dev/api/meals
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://gist-notice.dudu0.workers.dev/api/meals
```

Expected: `200 text/calendar; charset=utf-8`, `[]`, `401`

- [ ] **Step 4: 폰에서 캘린더를 구독해본다**

지꽁밥 탭 → "캘린더에 추가" → 이벤트를 하나 추가하고 캘린더 앱에 뜨는지, 취소하면 사라지는지 확인한다.

- [ ] **Step 5: README 를 갱신하고 커밋한다**

`README.md` 의 "기능" 목록에 한 줄 추가한다:

```markdown
- 지꽁밥 — 무료 식사 행사를 모아 보여주고 캘린더로 구독 (`/api/meals.ics`)
```

```bash
git add README.md
git commit -m "docs: README 에 지꽁밥 추가"
git push origin main
```

---

## 이 계획에 없는 것

설계 문서의 2·3단계다. 이 계획을 끝내고 따로 잡는다.

- 지글 refresh token 으로 `/notice` 읽기
- Gmail + Apps Script 로 메일 후보 적재
- 확정 시 푸시 알림 — 0단계에서는 화면과 캘린더만. 알림은 소스가 붙어 후보가
  실제로 얼마나 쌓이는지 보고 정한다
- 중복 병합 — 소스가 하나뿐이라 아직 중복이 안 생긴다
