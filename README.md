# GIST 학사공지 알림

GIST 학사공지 게시판에 새 글이 올라오면 폰 잠금화면으로 푸시 알림을 보내는 PWA.

링크 하나로 친구들에게 공유되고, 홈 화면에 추가하면 앱처럼 쓴다.
iOS·Android 둘 다 지원. 서버 비용 0원.

## 어떻게 동작하나

푸시는 3자 구조다. 서버가 폰에 직접 쏘지 못하고 푸시 서비스를 거친다.

```
Worker ──(VAPID 서명 POST)──> 푸시 서비스(FCM/APNs) ──> 폰의 service worker
```

### A. 구독 등록 (알림 켜기 버튼을 누를 때, 1회)

```
링크 클릭 → Worker가 index.html 서빙
  → OS 감지: iOS인데 홈 화면이 아니면 설치 안내 / 그 외는 버튼
  → (클릭) 알림 권한 요청
  → GET /api/vapid 로 공개키
  → pushManager.subscribe(공개키)
  → 폰이 FCM/APNs에서 endpoint 발급받아 반환
  → POST /api/subscribe
  → KV에 sub:<sha256(endpoint)> 저장
```

### B. 알림 발송 (30분마다 자동)

```
Cron Trigger 발화
  → 게시판 HTML fetch → parse() → [{no, category, title, date}]
  → KV lastNo 와 비교해 새 글만 추림 (없으면 종료)
  → 구독자 전원에게 병렬 발송
       ├ 410/404 → 죽은 구독, KV에서 삭제
       └ 성공 → 폰 잠금화면 알림
  → KV lastNo = max(no)
```

새 글 판정은 글 번호 하나로 끝난다. 게시판의 `no`가 단조 증가하므로
`no > lastNo` 면 새 글이다. 해시나 본문 비교가 필요 없다.

## 기술 선택

| | 선택 | 이유 |
|---|---|---|
| 앱 형태 | PWA | 링크로 배포됨. Flutter는 iOS에 $99/년 + 심사, Android는 APK 사이드로딩 |
| 실행 환경 | Cloudflare Workers | 정적 호스팅 + API + KV + Cron을 한 곳에서. 무료 |
| 언어 | JavaScript | Workers도 브라우저도 JS. 언어 전환 없음 |
| 빌드 도구 | 없음 | 화면이 버튼 하나 + 목록 하나. 번들러 설정이 코드보다 커진다 |
| HTML 파싱 | 정규식 | Workers에 DOM이 없다. 마크업이 규칙적이라 정규식이 가장 짧다 |
| 테스트 | `node --test` | Node 내장. Jest/Vitest 설치 안 함 |
| 푸시 발송 | `@block65/webcrypto-web-push` | npm `web-push`는 `crypto.createECDH`를 써서 Workers에서 죽는다 |

## 구조

```
src/parse.js     게시판 HTML → 공지 객체 배열
src/diff.js      새 글 골라내기 (순수 함수)
src/push.js      푸시 발송 (암호화 + VAPID 서명)
src/worker.js    fetch 핸들러(API) + scheduled 핸들러(크론)
public/          index.html, sw.js, manifest.json, 아이콘
test/            node --test 용 테스트 + 게시판 HTML 픽스처
```

## 개발

```bash
npm install
npm test                  # 파서 · diff 테스트
npx wrangler dev          # 로컬 실행
curl localhost:8787/cdn-cgi/local/scheduled   # 크론 강제 발화
npx wrangler deploy       # 배포
```

## 진행 상황

- [x] 0. 환경 확인
- [x] 0.5. JS 워밍업 (`scratch.js`)
- [x] 1. `src/parse.js` — HTML 파싱
- [x] 2. `src/diff.js` — 새 글 골라내기
- [x] 3. Cloudflare 배포 뼈대
- [x] 4. `worker.js` fetch 핸들러 — 구독 API
- [x] 5. `public/index.html` — 구독 화면
- [x] 6. `public/sw.js` — service worker
- [x] 7. `worker.js` scheduled 핸들러 — 크론
- [x] 8. 배포 완료 — https://gist-notice.dudu0.workers.dev
- [x] 9. 폰에서 알림 켜고 실제 수신 확인

## 주의

VAPID **개인키는 절대 커밋하지 않는다.** `wrangler secret put VAPID_PRIVATE_KEY` 로만 등록.
공개키는 `wrangler.jsonc` 의 `vars` 에 있어도 무방하다.
