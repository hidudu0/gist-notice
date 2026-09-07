# 배포 (딱 5분, 네가 해야 하는 부분)

브라우저 인증이 필요해서 이 부분만 직접 해야 한다. 순서대로 복붙하면 된다.

```bash
cd ~/Desktop/학사공지/gist-notice
```

## 1. Cloudflare 로그인

```bash
npx wrangler login
```

브라우저가 열린다. Cloudflare 계정이 없으면 그 화면에서 무료 가입.
**카드 등록 필요 없음.** 끝나면 확인:

```bash
npx wrangler whoami
```

## 2. KV 저장소 만들기

```bash
npx wrangler kv namespace create GIST
```

출력에 이런 줄이 나온다:

```
"id": "abc123def456..."
```

그 id 를 복사해서 `wrangler.jsonc` 의 `"id": "PLACEHOLDER"` 자리에 붙여넣는다.

## 3. VAPID 개인키 등록

로컬 개발용 키는 이미 `.dev.vars` 에 있다. 같은 키를 서버에도 등록한다:

```bash
grep VAPID_PRIVATE_KEY .dev.vars | cut -d= -f2 | npx wrangler secret put VAPID_PRIVATE_KEY
```

이 키는 git 에 올라가지 않는다. Cloudflare 에만 저장된다.

## 4. 배포

```bash
npx wrangler deploy
```

`https://gist-notice.<계정이름>.workers.dev` 주소가 나온다.

## 5. 첫 크론 돌리기

배포 직후 KV 가 비어 있어서 목록이 안 뜬다. 한 번 강제로 돌린다:

```bash
npx wrangler dev --remote --port 8787
# 다른 터미널에서
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

첫 실행은 알림을 보내지 않고 현재 글 번호만 기록한다(25건 알림 폭탄 방지).
이후 30분마다 자동으로 돈다.

## 6. 폰에서 확인

### 안드로이드
1. 크롬으로 주소 접속
2. **알림 켜기** 누르고 허용

### 아이폰 (iOS 16.4 이상)
1. **사파리로** 주소 접속 (크롬 아님)
2. 공유 버튼 → **홈 화면에 추가**
3. 홈 화면에 생긴 아이콘으로 **다시 열기**
4. **알림 켜기** 누르고 허용

사파리 탭에서는 버튼 대신 설치 안내가 뜬다. 정상이다.
아이폰은 홈 화면에 추가해야만 푸시가 온다.

## 7. 알림 실제로 오는지 테스트

구독한 뒤, 마지막 글 번호를 일부러 낮춰서 새 글이 있는 것처럼 만든다:

```bash
npx wrangler kv key put --binding GIST --remote lastNo "223200"
npx wrangler dev --remote --port 8787
# 다른 터미널에서
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

폰 잠금화면에 알림이 뜨면 완료.

## 8. 친구에게 배포

주소를 카톡으로 보내면 끝. 아이폰 친구에게는 "사파리로 열고 홈 화면에 추가"
한마디만 덧붙이면 된다 (화면에도 안내가 뜬다).

---

## 문제가 생기면

```bash
npx wrangler tail        # 실시간 로그
```

| 증상 | 확인할 것 |
|---|---|
| 목록이 비어 있음 | 크론이 한 번도 안 돌았다. 5번 다시 |
| 알림 켜기가 실패 | `wrangler tail` 로그에서 /api/subscribe 응답 확인 |
| 아이폰에서 버튼이 안 보임 | 홈 화면 아이콘으로 열었는지 확인 |
| 알림이 안 옴 | `wrangler tail` 에 "푸시 실패" 가 찍히는지 확인 |
