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
