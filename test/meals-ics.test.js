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
