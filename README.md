# GIST 학사공지 알림

GIST 학사공지 게시판에 새 글이 올라오면 폰 잠금화면으로 푸시 알림을 보내는 PWA.

링크 하나로 친구들에게 공유되고, 홈 화면에 추가하면 앱처럼 쓴다.
iOS·Android 둘 다 지원. 서버 비용 0원.

**운영 중** — https://gist-notice.dudu0.workers.dev

## 기능

- 30분마다 게시판을 확인해 새 글이 있으면 잠금화면 알림
- 공지 목록 열람, 제목 검색, 카테고리 필터, 당겨서 새로고침
- 알림 테스트 버튼 — 실제로 오는지 그 자리에서 확인하고, 만료된 구독이면 정리까지
- 구독 해제
- 장애 감시 — 게시판 확인이 연속 실패하면 관리자 기기로 경고 알림
- 브로드캐스트 — 공지와 무관한 메시지를 구독자 전원에게 (`npm run send`)
- 구독 180일 TTL — 앱을 열 때마다 갱신되므로, 안 쓰는 구독은 저절로 사라진다

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
  → 알림 한 건으로 묶는다
       ├ 1건이면 그 글 제목 + 그 글로 가는 링크
       └ 여러 건이면 "새 학사공지 N건" + 제목 목록
  → 구독자 전원에게 병렬 발송
       ├ 410/404 → 죽은 구독, KV에서 삭제
       └ 성공 → 폰 잠금화면 알림
  → KV lastNo = max(no), 목록·카테고리 캐시 갱신
```

새 글이 여러 건일 때 알림을 각각 쏘지 않고 하나로 묶는 이유는 두 가지다.
잠금화면이 도배되지 않고, Workers 의 subrequest 한도에 여유가 생긴다.

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

## API

| 메서드 | 경로 | 인증 | 하는 일 |
|---|---|---|---|
| GET | `/api/vapid` | — | VAPID 공개키 |
| GET | `/api/latest` | — | 최근 공지 목록 (크론이 캐시해둔 것) |
| GET | `/api/meta` | — | 구독자 수, 카테고리 목록 |
| POST | `/api/subscribe` | — | 구독 등록 · TTL 갱신 |
| POST | `/api/unsubscribe` | — | 구독 해제 |
| POST | `/api/test` | — | 자기 자신에게 테스트 알림 |
| POST | `/api/run` | 토큰 | 크론을 지금 1회 실행 |
| POST | `/api/broadcast` | 토큰 | 구독자 전원에게 직접 메시지 |

`/api/test` 가 인증 없이 열려 있어도 되는 이유: 보내려면 그 기기의 endpoint 와
암호키를 알아야 한다. 남에게는 보낼 수 없다.

`/api/run` 과 `/api/broadcast` 는 `x-admin-token` 헤더가 필요하다.
열어두면 아무나 우리 이름으로 GIST 서버를 계속 긁거나, 구독자에게
임의의 메시지를 보낼 수 있다.

## 보안 설계

**구독 endpoint 를 검증한다.** `/api/subscribe` 는 누구나 부를 수 있는 공개
엔드포인트다. 검증 없이 저장하면 아무 URL 이나 KV 에 쌓이고, 크론이 30분마다
그 주소로 요청을 보내게 된다 — 서버가 남을 공격하는 도구가 된다.
그래서 실제 푸시 서비스 호스트(FCM/APNs/Mozilla 등)인지, HTTPS 인지,
키 길이가 정상 범위인지 확인한다.

**푸시 본문 길이를 자른다.** 4KB 를 넘으면 발송이 통째로 실패한다.

**관리자 기기 등록.** 페이지를 `#admin=<토큰>` 으로 한 번 열고 구독하면
그 기기가 장애 알림을 받는다. 게시판 확인이 연속 2회 실패하면 경고가 온다.

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

## 운영

```bash
npm run deploy     # 배포
npm run logs       # 실시간 로그
npm run check      # 크론을 지금 1회 실행 (.dev.vars 의 토큰 사용)
npm run subs       # 구독자 수
npm run state      # 저장된 lastNo
npm run send "제목" "내용" [링크]    # 구독자 전원에게 메시지
```

배포 절차와 시크릿 등록은 [DEPLOY.md](DEPLOY.md) 를 본다.

## 관련 저장소

같은 앱을 express 와 NestJS 로 다시 만들어본 학습 기록이 따로 있다 —
[gist-notice-study](https://github.com/hidudu0/gist-notice-study).
그쪽은 로컬 전용이고 배포하지 않았다. 이 저장소가 실제 운영판이다.

## 주의

VAPID **개인키는 절대 커밋하지 않는다.** `wrangler secret put VAPID_PRIVATE_KEY` 로만 등록.
공개키는 `wrangler.jsonc` 의 `vars` 에 있어도 무방하다.
