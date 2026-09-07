// 실행: npm test
//
// 이 파일이 "정답의 정의" 다. parse() 가 이걸 통과하면 1단계 완료.
// 나중에 GIST 가 게시판 마크업을 바꾸면 여기서 먼저 빨간불이 뜬다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../src/parse.js';

// 2026-09-02 에 실제 게시판에서 받아둔 HTML
const html = readFileSync(new URL('./board.html', import.meta.url), 'utf8');
const items = parse(html);

test('공지를 여러 건 찾아낸다', () => {
  assert.ok(items.length >= 10, `10건 이상이어야 하는데 ${items.length}건 나옴`);
});

test('각 칸이 제대로 채워진다', () => {
  const it = items.find((c) => c.no === 223132);
  assert.ok(it, 'no=223132 공지를 못 찾음');
  assert.equal(it.category, '장학/납입금');
  assert.equal(it.date, '2026-09-01');
  assert.match(it.title, /국가장학금/);
});

test('no 는 문자열이 아니라 숫자다', () => {
  // '223132' 가 아니라 223132 여야 한다.
  // 문자열이면 나중에 no > lastNo 비교가 엉뚱하게 동작한다.
  assert.equal(typeof items[0].no, 'number');
});

test('HTML 엔티티가 복원된다', () => {
  // 제목에 &amp; &#039; 같은 암호가 남아 있으면 알림이 지저분해진다
  const 지저분 = items.filter((c) => /&(amp|#0?39|quot|lt|gt);/.test(c.title));
  assert.equal(지저분.length, 0, `엔티티가 남은 제목: ${지저분.map((c) => c.title)}`);
});

test('빈 제목이 없다', () => {
  const 빈것 = items.filter((c) => !c.title);
  assert.equal(빈것.length, 0, `제목이 빈 항목 ${빈것.length}건`);
});

test('제목에 낀 NEW 아이콘 태그를 걷어낸다', () => {
  // 실제로 터졌던 버그. 게시판은 최근 글 제목 앞에 아이콘을 넣는다:
  //   <a href='…'><img src='/bbs/img/common/list_icon_new.gif' …> [학사] 제목</a>
  // 태그를 안 벗기면 알림 제목이 "<img src=…" 로 나간다.
  const 가짜 = `<tr id='BBSList999999' class='lstNtc'>
    <td class=category>학사</td>
    <td class=title> <a href='?mode=V&amp;no=999999'><img src='/bbs/img/common/list_icon_new.gif' alt='신규'> [학사] 새 글 제목</a> </td>
    <td class=reg_date>2026-09-07</td>`;
  const [it] = parse(가짜);
  assert.equal(it.title, '[학사] 새 글 제목');
  assert.ok(!it.title.includes('<'), '제목에 태그가 남았다');
});

test('픽스처의 모든 제목에 HTML 태그가 없다', () => {
  const 태그있음 = items.filter((c) => /[<>]/.test(c.title));
  assert.equal(태그있음.length, 0);
});
