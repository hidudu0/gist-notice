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
