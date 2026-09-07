// 구독자 전원에게 메시지를 직접 보낸다.
//
//   npm run send "제목" "내용"
//   npm run send "제목" "내용" "https://링크"
//
// 링크를 생략하면 알림을 눌렀을 때 이 사이트가 열린다.

import { readFileSync } from 'node:fs';

const WORKER = 'https://gist-notice.dudu0.workers.dev';

const [title, body, url] = process.argv.slice(2);

if (!title || !body) {
  console.error('사용법: npm run send "제목" "내용" [링크]');
  process.exit(1);
}

// 관리자 토큰은 .dev.vars 에만 있다 (git 에 안 올라감)
const token = readFileSync('.dev.vars', 'utf8').match(/^ADMIN_TOKEN=(.*)$/m)?.[1]?.trim();
if (!token) {
  console.error('.dev.vars 에서 ADMIN_TOKEN 을 못 찾았습니다');
  process.exit(1);
}

const res = await fetch(`${WORKER}/api/broadcast`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-admin-token': token },
  body: JSON.stringify({ title, body, url }),
});

const out = await res.json().catch(() => ({}));

if (!res.ok) {
  console.error(`실패 (HTTP ${res.status}):`, out.error ?? '');
  process.exit(1);
}

console.log(`${out.sent}명에게 보냈습니다.`);
