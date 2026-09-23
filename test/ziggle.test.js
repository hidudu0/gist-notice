import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripHtml, toCandidate, noticeUrl } from '../src/ziggle.js';

const TODAY = '2026-09-23';

const 공지 = {
  id: 12345,
  title: '[총학생회] 무료 점심 나눔',
  content: '<p>9월 25일 12:00 학생회관 1층에서 <b>무료</b> 점심을 제공합니다.</p>',
  deadline: null,
  currentDeadline: null,
};

test('태그를 벗기고 공백을 정리한다', () => {
  assert.equal(stripHtml('<p>가나  <b>다라</b></p>'), '가나 다라');
  assert.equal(stripHtml(null), '');
  assert.equal(stripHtml(undefined), '');
});

test('식사 행사면 후보로 바꾼다', () => {
  const c = toCandidate(공지, TODAY);
  assert.equal(c.id, 'ziggle:12345');
  assert.equal(c.source, 'ziggle');
  assert.equal(c.title, '[총학생회] 무료 점심 나눔');
  assert.equal(c.sourceUrl, 'https://ziggle.gistory.me/notice/12345');
});

test('제목만으로는 안 걸려도 본문을 보고 걸러낸다', () => {
  const c = toCandidate(
    { id: 7, title: '학생 간담회 안내', content: '참석자에게 도시락을 무료로 제공합니다' },
    TODAY,
  );
  assert.notEqual(c, null);
  assert.equal(c.id, 'ziggle:7');
});

test('식사 행사가 아니면 null', () => {
  assert.equal(toCandidate({ id: 8, title: '무료 특강 안내', content: '강연이 있습니다' }, TODAY), null);
  assert.equal(toCandidate({ id: 9, title: '동아리 모집', content: '' }, TODAY), null);
});

test('id 나 제목이 없으면 null', () => {
  assert.equal(toCandidate({ title: '무료 점심 제공' }, TODAY), null);
  assert.equal(toCandidate({ id: 1 }, TODAY), null);
  assert.equal(toCandidate(null, TODAY), null);
});

test('본문에서 날짜와 시각을 뽑는다', () => {
  const c = toCandidate(공지, TODAY);
  assert.equal(c.guess.date, '2026-09-25');
  assert.equal(c.guess.start, '12:00');
});

test('마감일은 본문에 적어주되 행사 날짜로 쓰지 않는다', () => {
  const c = toCandidate(
    { id: 11, title: '무료 도시락 배부', content: '학생회관에서 배부합니다', deadline: '2026-10-05T00:00:00.000Z' },
    TODAY,
  );
  assert.match(c.text, /신청 마감 2026-10-05/);
  // 본문에 행사 날짜가 없으므로 비어 있어야 한다. 마감일이 새어 들어오면 안 된다.
  assert.equal(c.guess.date, '');
});

test('currentDeadline 이 deadline 보다 우선한다', () => {
  const c = toCandidate(
    {
      id: 12,
      title: '무료 간식 제공',
      content: '선착순입니다',
      deadline: '2026-10-05T00:00:00.000Z',
      currentDeadline: '2026-10-09T00:00:00.000Z',
    },
    TODAY,
  );
  assert.match(c.text, /신청 마감 2026-10-09/);
  assert.ok(!c.text.includes('2026-10-05'));
});

test('아주 긴 본문은 잘라낸다', () => {
  const c = toCandidate({ id: 13, title: '무료 점심 제공', content: '가'.repeat(9000) }, TODAY);
  assert.equal(c.text.length, 4000);
});

test('noticeUrl 은 지글 웹 주소를 만든다', () => {
  assert.equal(noticeUrl(99), 'https://ziggle.gistory.me/notice/99');
});
