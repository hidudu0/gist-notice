# 배포 현황 & 운영

**주소: https://gist-notice.kdylee0713.workers.dev**

배포는 끝났다. 남은 건 폰에서 알림을 켜는 것뿐.

## 완료된 것

| 항목 | 상태 |
|---|---|
| Cloudflare 로그인 · 이메일 인증 | 완료 |
| KV 저장소 `GIST` | 완료 (`ac1c148a…`) |
| VAPID 개인키 · ADMIN_TOKEN 시크릿 | 완료 |
| 배포 | 완료 |
| 공지 목록 20건 수집 | 완료 |
| 30분 자동 확인 | 완료 (GitHub Actions) |

## 폰에서 알림 켜기

### 안드로이드
1. 크롬으로 https://gist-notice.kdylee0713.workers.dev 접속
2. **알림 켜기** → 허용

### 아이폰 (iOS 16.4 이상)
1. **사파리로** 접속 (크롬 아님)
2. 공유 버튼 → **홈 화면에 추가**
3. 홈 화면에 생긴 아이콘으로 **다시 열기**
4. **알림 켜기** → 허용

사파리 탭에서 열면 버튼 대신 설치 안내가 뜬다. 정상이다.
아이폰은 홈 화면에 추가해야만 푸시가 온다.

## 알림이 실제로 오는지 테스트

구독한 뒤, 마지막 글 번호를 낮춰 새 글이 있는 것처럼 만든다:

```bash
cd ~/Desktop/학사공지/gist-notice
npx wrangler kv key put --binding GIST --remote lastNo "223200"
curl -X POST -H "x-admin-token: $(grep ADMIN_TOKEN .dev.vars | cut -d= -f2)" \
  https://gist-notice.kdylee0713.workers.dev/api/run
```

응답에 `{"fresh":3,"sent":1}` 처럼 나오고 폰에 알림이 뜨면 성공.

## 친구에게 배포

주소를 보내면 끝. 아이폰 친구에게는 "사파리로 열고 홈 화면에 추가" 한마디만
덧붙이면 된다 (화면에도 안내가 뜬다).

## 30분 자동 확인은 어떻게 도나

Cloudflare 의 Cron Trigger 를 설정해뒀지만 **실제로 발화하지 않는다.**
등록은 되는데(`/schedules` API 로 확인) scheduled 이벤트가 한 번도 안 들어온다.
무료 플랜 신규 계정에서 다수 보고된 문제다. 같은 Worker 의 fetch 는 정상이다.

그래서 **GitHub Actions** 가 30분마다 `/api/run` 을 호출한다
(`.github/workflows/check.yml`). Cloudflare 크론 설정은 그대로 뒀다 —
나중에 살아나도 중복 실행은 무해하다(두 번째는 새 글 없음으로 판단).

주의: GitHub 무료 계정은 리포에 **60일간 활동이 없으면 예약 워크플로를 끈다.**
알림이 갑자기 멈추면 Actions 탭에서 다시 켜면 된다.

## 알림 주기 바꾸기

`.github/workflows/check.yml` 의 `cron` 값을 고치고 push 하면 된다.

| 원하는 것 | 값 |
|---|---|
| 30분마다 (현재) | `*/30 * * * *` |
| 1시간마다 | `0 * * * *` |
| 낮에만 (KST 9~19시) | `0 0-10 * * *` (UTC 기준) |
| 하루 1회 (KST 아침 9시) | `0 0 * * *` |

## 문제가 생기면

```bash
npx wrangler tail                                    # Worker 실시간 로그
gh run list --workflow=check-notices --limit 5       # 자동 확인 이력
```

| 증상 | 확인할 것 |
|---|---|
| 목록이 비어 있음 | 위 `/api/run` 을 직접 호출해본다 |
| 알림 켜기가 실패 | `wrangler tail` 에서 /api/subscribe 응답 확인 |
| 아이폰에서 버튼이 안 보임 | 홈 화면 아이콘으로 열었는지 확인 |
| 알림이 안 옴 | `wrangler tail` 에 "푸시 실패" 가 찍히는지 확인 |
| 갑자기 다 멈춤 | GitHub Actions 가 60일 비활성으로 꺼졌는지 확인 |
