import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff } from '../src/diff.js';

const 게시판 = [
  { no: 223143, title: 'C' },
  { no: 223132, title: 'B' },
  { no: 223096, title: 'A' },
];

test('첫 실행이면 알림을 보내지 않고 번호만 기록한다', () => {
  const r = diff(게시판, 0);
  assert.deepEqual(r.fresh, []);
  assert.equal(r.maxNo, 223143);
});

test('새 글이 없으면 빈 배열', () => {
  const r = diff(게시판, 223143);
  assert.deepEqual(r.fresh, []);
  assert.equal(r.maxNo, 223143);
});

test('새 글만 골라 오래된 것부터 돌려준다', () => {
  const r = diff(게시판, 223000);
  assert.deepEqual(r.fresh.map((c) => c.title), ['A', 'B', 'C']);
  assert.equal(r.maxNo, 223143);
});

test('경계값: lastNo 와 같은 번호는 새 글이 아니다', () => {
  const r = diff(게시판, 223132);
  assert.deepEqual(r.fresh.map((c) => c.no), [223143]);
});

test('파싱 실패로 빈 배열이 와도 lastNo 를 날리지 않는다', () => {
  // 이 방어가 없으면 게시판 개편 때 lastNo 가 0 으로 초기화되고
  // 다음 실행에서 전체 공지가 알림 폭탄으로 나간다.
  const r = diff([], 223143);
  assert.deepEqual(r.fresh, []);
  assert.equal(r.maxNo, 223143);
});
