# 지꽁밥 — 설계

2026-09-23

GIST 학생이 참여해서 무료로 점심·저녁을 먹을 수 있는 행사를 한곳에 모은다.
기존 학사공지 알림 앱에 탭으로 붙이고, 캘린더 구독(ICS)으로도 내보낸다.

기존 공지 기능은 그대로 둔다. 이 문서는 그 옆에 붙는 것만 다룬다.

## 왜 이 구조인가

핵심 제약은 **소스마다 공개 여부가 다르다**는 것이다.

| 소스 | 성격 | 지금 앱 구조에 맞나 |
| --- | --- | --- |
| 학사공지 | 공개, 전원 동일 | 맞는다 |
| 지글 | 공개, 전원 동일 | 맞는다 |
| Outlook 메일 | **개인** | 안 맞는다 |

지금 앱은 KV `latest` 하나를 구독자 전원이 똑같이 본다. 메일은 내 개인 것이라
그대로 흘리면 남의 폰에 내 메일이 간다. 그래서 **수집과 공개 사이에 내 승인을
끼운다**. 승인 게이트는 두 가지를 동시에 푼다.

- 개인정보 — 내 메일에서 나온 것이 그대로 나가지 않는다
- 오탐 — "다과 제공"이 실제로는 교직원 회의일 수 있다

지꽁밥 탭은 **구독자 전원 공개**다. 그래서 승인 게이트는 선택이 아니라 필수다.

## 파이프라인

```
수집                      선별            확정          출력
──────────────────────    ───────────     ──────────    ────────────────
학사공지 크론(이미 있음) ┐
지글 API (내 토큰)       ├→ 키워드 후보 → [내 승인]  → 앱 탭 "지꽁밥"
Gmail → Apps Script      ┘   mealq:<id>    meal:<id>    /api/meals.ics
                                                        푸시 알림
```

단계를 넷으로 끊은 이유: 수집은 언제든 끊긴다(토큰 만료, 게시판 개편, 학교 정책
변경). 선별·확정·출력은 수집과 무관하게 돌아야 한다. 소스 하나가 죽어도 나머지는
그대로 간다.

## 관문 조사 결과 (2026-09-23 확인)

다시 조사하지 않도록 남겨둔다.

### 지글 — 조건부 가능

- `ziggle.gistory.me` 는 Vite+React SPA. HTML 이 1KB 껍데기라 학사공지처럼
  정규식으로 긁을 것이 없다
- 백엔드는 `https://api.ziggle.gistory.me`. 경로는 `/notice`, `/notice/{id}`,
  `/tag`, `/notice/rss`
- `/notice` 와 `/notice/rss` 는 401. 공개는 `/tag` 뿐. RSS 가 404 가 아니라
  401 이라는 건 만들어두고 잠갔다는 뜻이다
- 인증은 GIST 통합 IdP `account.gistory.me` (OIDC). `client_id` 는 번들에
  노출되어 있고(`b0c3a25f-1291-410c-bac3-192094d47c77`), scope 에
  `offline_access` 가 있어 refresh token 발급이 가능하다
- 지글은 자체 FCM 푸시가 있다(`/user/fcm`). 같은 공지를 그대로 얹으면 알림이
  두 번 온다 — 알림 정책에서 고려할 것

경로는 셋이었다. (a) GISTORY 팀에 API 키나 RSS 개방 요청, (b) 내 계정으로 로그인해
refresh token 을 확보하고 크론이 갱신, (c) 링크만 걸고 긁지 않음. **(b) 로 간다.**

### 지글 인증 사슬 (2026-09-23 실측 확인)

실제로 끝까지 통과시켜 확인했다. 토큰이 두 겹이고, IdP 토큰으로는 `/notice` 가 열리지
않는다는 것이 핵심이다.

```
KV ziggleRefresh (IdP refresh token, 90일)
  → POST https://api.account.gistory.me/oauth/token
        grant_type=refresh_token, client_id=b0c3a25f-1291-410c-bac3-192094d47c77,
        redirect_uri=https://ziggle.gistory.me/auth/callback
    → 200 { access_token, refresh_token, expires_in: 10800, refresh_token_expires_in: 7776000 }
  → POST https://api.ziggle.gistory.me/auth/login
        Authorization: Bearer <IdP access_token>   ← 헤더다. 본문에 실으면 401
    → 201 { access_token }                          ← 지글 토큰, 253자
  → GET https://api.ziggle.gistory.me/notice
        Authorization: Bearer <지글 access_token>
    → 200 { total, list }
```

측정값과 제약:

- **client secret 이 필요 없다.** SPA 가 `react-oauth2-code-pkce` 를 쓰는 공개 클라이언트다.
  OIDC 메타데이터는 `client_secret_basic/post` 만 광고하지만 실제로는 client_id 만으로 통과한다
- IdP access token 3시간, refresh token 90일 (`7776000`초)
- IdP access token 으로 `/notice` 를 부르면 401 이다. 쿠키만으로도 401 이다.
  지글 토큰만 열린다
- 항목 필드: `id, title, group, author, createdAt, views, langs, content, reactions,
  category, deadline, currentDeadline, publishedAt, imageUrls, documents, crawledUrl, tags`.
  **본문(`content`)과 마감(`deadline`)이 함께 온다** — 제목만 있는 학사공지보다 날짜·마감
  추출이 훨씬 유리하다
- scope: `offline_access name email`

**refresh token 이 회전한다.** 한 번 쓰면 새것으로 바뀌고 이전 것은 죽는다. 그래서:

- 토큰은 `wrangler secret` 이 아니라 **KV `ziggleRefresh`** 에 둔다. 런타임에 새 값을 써야 한다
- 브라우저와 크론이 같은 토큰을 공유할 수 없다. 크론이 갱신하면 지글 웹 세션이 끊기고,
  지글 웹을 쓰면 크론이 끊긴다. 이것이 (b) 를 "지속 가능하지 않다"고 적었던 이유이고,
  실측으로 확인됐다
- 갱신 횟수를 줄인다: 지글 access token 을 만료까지 KV 에 캐시해, 크론 대부분의 회차는
  캐시된 토큰만 쓴다. IdP 갱신은 3시간에 한 번, 하루 8회
- 끊기면 조용히 죽지 않게 한다: refresh 가 401 이면 기존 장애 감시 경로로 관리자 기기에
  알림을 보낸다. 복구는 지글에 다시 로그인해 토큰을 다시 넣는 것이다

이 제약이 싫어지면 (a) 로 돌린다. GISTORY 팀이 `/notice/rss` 를 이미 만들어뒀다(401 로 잠겨
있을 뿐이다) 는 것이 요청의 명분이 된다.

### Outlook — Microsoft Graph 는 막혔다

- GIST 는 Microsoft 365 테넌트 `734c471f-b734-476c-84b0-3d3c6cdcd28f`,
  학생 메일은 `@gm.gist.ac.kr` → `gm-gist-ac-kr.mail.protection.outlook.com`
- **앱 등록 블레이드가 학생에게 차단**되어 있다. Entra 관리 센터에서
  `NavigationDisallowed`, HTTP 403, "권한이 부족하여 작업을 완료할 수 없습니다"
- 개인 Entra 테넌트를 따로 만들어 multi-tenant 앱으로 우회하는 길도 막혔다.
  Microsoft 문서: *"Only paid customers can create a new Workforce tenant."*
  유료 Azure 계정이 필요하다
- 설사 만들어도 GIST 테넌트가 `Mail.Read` 사용자 동의를 허용해야 한다. 앱 등록
  블레이드까지 잠근 테넌트가 이를 열어뒀을 가능성은 낮다. Microsoft 기본값도
  검증된 게시자의 low-impact 권한만 허용하며 `Mail.Read` 는 low-impact 가 아니다
- IMAP/POP 도 같은 관문이다. 기본 인증이 폐지되어 결국 OAuth 토큰이 필요하다

**결론: Graph 경로는 포기한다.**

### Outlook — 전달 경로는 열려 있다 (확인 완료)

Outlook 규칙으로 외부 주소(Gmail)에 전달되는 것을 실제로 확인했다. 이 경로는
Microsoft 쪽 협조가 전혀 필요 없다.

Cloudflare Email Routing(Email Worker 로 직접 수신)이 더 깔끔하지만 Cloudflare DNS 를
쓰는 도메인이 필요하다 — *"You must be using Cloudflare DNS to use Email Service."*
`workers.dev` 로는 안 된다. **도메인을 사지 않는다.** 지꽁밥 행사는 며칠 전에
공지되므로 15분 폴링 지연은 문제가 되지 않는다.

Gmail API 를 직접 쓰지 않는 이유: `gmail.readonly` 는 restricted scope 라 검증받지
않은 앱은 refresh token 이 7일마다 만료된다. 크론이 계속 끊긴다. Google Apps Script 는
내 계정 안에서 도는 스크립트라 OAuth 동의 절차 자체가 없고 그 문제가 없다.

## 데이터 모델

KV 키 세 갈래를 쓴다.

```
mealq:<id>   승인 대기 후보
meal:<id>    확정 이벤트
meals        확정 목록 캐시 — 앱 탭과 ICS 가 읽는다
```

`meals` 를 따로 두는 이유는 기존 `latest` 와 같다. 읽기는 잦고 쓰기는 드무니
KV list 를 매 요청마다 돌리지 않는다.

`id` 는 `<source>:<sourceId>` 다.

```
gist:223816        학사공지 글 번호
ziggle:12345       지글 공지 id
mail:<해시>        메일 messageId 의 sha256 앞자리
manual:<시각>      내가 손으로 넣은 것
```

같은 행사가 세 소스에 다 뜨면 id 가 셋 생긴다. 자동 병합하지 않는다 —
승인 화면에서 내가 합친다. 날짜·장소·제목이 미묘하게 다르게 적히는 일이 잦아
자동 판정이 오히려 틀린다.

```
{
  id, title,
  date,                                    // 'YYYY-MM-DD'
  start, end,                              // 'HH:MM' | null
  place, host,
  signup: { required, url, deadline, capacity },
  source, sourceUrl,
  note,
  updatedAt
}
```

`start` 가 없으면 종일 이벤트로 취급한다. 공지에 시간이 안 적힌 경우가 많다.

## 엔드포인트

| 경로 | 메서드 | 권한 | 하는 일 |
| --- | --- | --- | --- |
| `/api/meals` | GET | 공개 | 확정 목록 |
| `/api/meals.ics` | GET | 공개 | 캘린더 구독 피드 |
| `/api/meals/queue` | GET | ADMIN_TOKEN | 승인 대기 후보 |
| `/api/meals/queue` | POST | ADMIN_TOKEN | 후보 적재 (Apps Script·지글 크론이 쓴다) |
| `/api/meals` | POST | ADMIN_TOKEN | 승인 또는 직접 추가 |
| `/api/meals/:id` | DELETE | ADMIN_TOKEN | 삭제 |

승인과 직접 추가를 같은 경로로 둔다. 승인은 "후보를 다듬어서 확정에 넣는 것"이고
직접 추가는 "빈 것을 다듬어서 확정에 넣는 것"이라 하는 일이 같다.

권한은 기존 `ADMIN_TOKEN` 과 `authed()` 를 그대로 쓴다. 새로 만들지 않는다.

## 화면

현재 UI 는 그대로 두고 위에 탭 두 개를 얹는다.

```
[ 공지 ] [ 지꽁밥 ]
```

- `공지` — 지금 화면 그대로. 알림 버튼, 검색, 칩, 목록
- `지꽁밥` — 날짜순 카드, 지난 행사는 숨김. 맨 위에 "캘린더에 추가"(webcal 링크)
- `adminToken` 이 있으면 지꽁밥 탭에 승인 대기 큐와 입력 폼이 함께 뜬다

탭 상태는 `localStorage` 에 남겨 다시 열었을 때 보던 탭이 유지되게 한다.

## ICS

```
UID:<id>@gist-notice
DTSTART;TZID=Asia/Seoul:20260925T120000
SUMMARY:<title>
LOCATION:<place>
```

주의할 점이 하나 있다. **삭제한 이벤트를 피드에서 그냥 빼면 안 된다.** 이미 구독한
캘린더에는 그대로 남아 유령이 된다. `STATUS:CANCELLED` 로 일정 기간(30일) 유지해야
구독자 캘린더에서 지워진다.

- 시간이 없으면 `VALUE=DATE` 종일 이벤트
- 수정할 때마다 `SEQUENCE` 증가. 안 올리면 캘린더가 변경을 무시한다
- `X-WR-CALNAME:지꽁밥`, `X-PUBLISHED-TTL:PT1H`
- 피드는 공개다. 탭이 공개이므로 숨길 것이 없다

## 수집 소스별

### 1단계 — 학사공지

기존 크론이 게시판을 파싱한 뒤, 제목이 키워드에 걸리면 `mealq:` 에 후보를 넣는다.
이미 긁고 있어서 추가 요청이 0이다.

```
무료 · 식사 제공 · 중식 · 석식 · 간식 · 다과 · 선착순 · 도시락 · 피자
```

### 2단계 — 지글

브라우저에서 한 번 로그인해 refresh token 을 확보하고 `wrangler secret` 에 넣는다.
크론이 access token 을 갱신하며 `/notice` 를 읽고 같은 키워드로 거른다.

토큰이 끊기면 그 소스만 조용히 빠진다. 기존 장애 감시(연속 실패 시 관리자 알림)에
얹어 끊김을 알아챈다.

### 3단계 — Outlook 메일

```
Outlook 규칙(조건 좁게) → Gmail 라벨 "지꽁밥" → Apps Script 15분 트리거
  → POST /api/meals/queue
```

두 가지를 지킨다.

- **Outlook 규칙 조건을 좁게 잡는다.** 전부 전달하면 개인 메일 전체가 Gmail 로
  넘어간다. 제목 키워드나 발신자(학생지원팀, 학과 사무실) 기준으로 거른다.
  수집 단계에서 줄이는 것이 가장 싸고 안전하다
- **Gmail 은 전용 라벨로 격리한다.** 필터가 전달분에 `지꽁밥` 라벨을 붙이고
  Apps Script 는 `label:지꽁밥 is:unread` 만 읽는다. 받은편지함 전체를 건드리지
  않는다. 처리한 것은 읽음 처리해 재전송을 막는다

`ADMIN_TOKEN` 은 Apps Script 의 스크립트 속성(Script Properties)에 넣는다.
코드에 박아두지 않는다.

Apps Script 가 보내는 것은 제목·발신자·본문 일부·받은 시각이다. **메일 원문은 KV 에
저장하지 않는다.** 후보에는 추출된 필드만 남긴다.

## 선별

키워드로 후보를 거르는 것까지만 자동이다. 날짜·시간·장소는 정규식으로 뽑을 수 있는
만큼만 뽑고 나머지는 승인 화면에서 내가 채운다.

LLM 추출은 넣지 않는다. 하루 몇 건이라 손으로 채우는 것이 더 빠르고, 어차피 승인은
거쳐야 한다. 후보가 감당 못 할 만큼 늘어나면 그때 붙인다.

## 알림

확정 시 1회 푸시한다. 기존 발송 경로(`sendPush`, 죽은 구독 정리 포함)를 그대로 쓴다.

마감 임박·당일 아침 알림이 공지 알림보다 쓸모 있지만 1차 범위에서는 뺀다.

## 파일

| 파일 | 변경 |
| --- | --- |
| `src/meals.js` | 신규 — 키워드 필터, 날짜 파싱, 정규화, ICS 생성 |
| `src/worker.js` | 라우트 추가. 크론에 후보 적재 한 줄 |
| `public/index.html` | 탭, 지꽁밥 화면, 승인 폼 |

기존 공지 경로(`parse.js`, `diff.js`, `push.js`)는 건드리지 않는다.

## 테스트

`src/meals.js` 는 전부 순수 함수라 기존 `test/` 패턴(`node --test`)을 그대로 쓴다.

- 키워드 필터 — 걸릴 것이 걸리고, 안 걸릴 것이 안 걸리는가
- 날짜 파싱 — `2026-09-25`, `9월 25일(목)`, `내일` 같은 표기
- ICS 생성 — 종일 이벤트, `SEQUENCE` 증가, `STATUS:CANCELLED` 유지

## 착수 순서

| 단계 | 내용 | 막히면 |
| --- | --- | --- |
| 0 | 수동 입력 + 앱 탭 + ICS 피드 | 없음 — 수집이 0개여도 기능이 완성된다 |
| 1 | 학사공지 키워드 필터 → 후보 큐 | 없음 — 이미 긁고 있다 |
| 2 | 지글 refresh token | **완료 (2026-09-23 운영 반영)** — 토큰이 끊기면 그 소스만 빠지고 관리자에게 알림 |
| 3 | Gmail + Apps Script | 전달은 확인됐다 |

0단계를 먼저 하는 이유: 승인 화면이 곧 수동 입력 화면이다. 어차피 만들어야 하고,
수집이 전부 막혀도 기능은 돌아간다.

## 미결정 · 위험

- ~~지글 토큰 수명을 모른다~~ — 확인했다. IdP access 3시간, refresh 90일, 회전형.
  `/notice` 는 기본 정렬이 최신순이 아니어서 `?orderBy=recent&limit=30` 이 필요하다
  (파라미터 없이 부르면 2023년 글부터 온다 — 운영에 올려보고 알았다)
- **지글 알림 중복.** 지글 자체 푸시를 쓰는 사람에게는 같은 행사가 두 번 간다.
  지글 출처 항목은 푸시에서 빼는 선택지가 있다
- **행사 날짜 파싱 실패율을 모른다.** 승인 화면에서 손으로 채우는 비율이 높으면
  그때 LLM 추출을 검토한다
- **키워드 오탐.** 첫 운영 몇 주의 후보 큐를 보고 키워드를 조정한다
