import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/meals.js';

// signup.url, sourceUrl 은 화면에서 href 에 그대로 꽂힌다.
// escapeHtml 은 스킴을 안 건드리므로 여기서 http/https 만 통과시켜야 한다.
const withSignupUrl = (url) =>
  normalize({ id: 'a', title: 'A', date: '2026-09-25', signup: { url } }, null).signup.url;

const withSourceUrl = (url) =>
  normalize({ id: 'a', title: 'A', date: '2026-09-25', sourceUrl: url }, null).sourceUrl;

test('http URL 은 그대로 통과한다', () => {
  assert.equal(withSignupUrl('http://example.com/form'), 'http://example.com/form');
  assert.equal(withSourceUrl('http://example.com/notice'), 'http://example.com/notice');
});

test('https URL 은 그대로 통과한다', () => {
  assert.equal(withSignupUrl('https://example.com/form'), 'https://example.com/form');
  assert.equal(withSourceUrl('https://example.com/notice'), 'https://example.com/notice');
});

test('javascript: 스킴은 막는다', () => {
  assert.equal(withSignupUrl('javascript:alert(1)'), '');
  assert.equal(withSourceUrl('javascript:alert(1)'), '');
});

test('data: 스킴은 막는다', () => {
  assert.equal(withSignupUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(withSourceUrl('data:text/html,<script>alert(1)</script>'), '');
});

test('URL 모양이 아니면 막는다', () => {
  assert.equal(withSignupUrl('이건 URL 이 아님'), '');
  assert.equal(withSourceUrl('/relative/path'), ''); // base 없이는 URL 이 못 만든다
});

test('빈 값·안 준 값은 빈 문자열을 유지한다', () => {
  assert.equal(withSignupUrl(''), '');
  assert.equal(withSignupUrl(undefined), '');
  assert.equal(normalize({ id: 'a', title: 'A', date: '2026-09-25' }, null).sourceUrl, '');
});

test('대소문자를 섞고 앞에 공백을 둬도 javascript: 는 막는다', () => {
  // new URL 이 스킴을 소문자로, 앞뒤 공백을 정리해서 파싱한다.
  // 우리 쪽에서 따로 안 다듬어도 걸러지는지 직접 확인한다.
  assert.equal(withSignupUrl('  JavaScript:alert(1)'), '');
  assert.equal(withSourceUrl('  JavaScript:alert(1)  '), '');
});
