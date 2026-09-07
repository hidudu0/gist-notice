// ===========================================================
//  푸시 한 건 보내기
//
//  브라우저가 준 구독(endpoint + 키 2개) 앞으로 암호화된 알림을 쏜다.
//  우리가 폰에 직접 못 쏘고, FCM(안드로이드) / APNs(아이폰) 를 거친다.
//
//  라이브러리가 대신 해주는 것:
//    - 본문을 aes128gcm 으로 암호화 (RFC 8291)
//      → 푸시 서비스는 내용을 못 읽는다. 폰에서만 복호화된다.
//    - VAPID JWT 서명 (RFC 8292)
//      → "이 서버가 보낸 게 맞다" 는 증명. 개인키로 서명한다.
//  직접 짜면 200줄이라 라이브러리를 쓴다.
//
//  npm 의 web-push 는 못 쓴다 — Node 전용 crypto.createECDH 를 호출해서
//  Workers 런타임에서 죽는다. 이 라이브러리는 WebCrypto 만 쓴다.
//  버전도 2.x 여야 한다. 1.x 는 레거시 aesgcm 방식이라 Apple 이 거부한다.
// ===========================================================

import { buildPushPayload } from '@block65/webcrypto-web-push';

/**
 * @param {object} subscription  브라우저가 준 구독 객체
 * @param {{title:string, body:string, url:string}} data  알림 내용
 * @param {object} env  Worker 환경변수 (VAPID 키들)
 * @returns {Promise<Response>}  푸시 서비스의 응답. 201이면 성공.
 */
export async function sendPush(subscription, data, env) {
  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY, // wrangler secret 으로만 주입된다
  };

  const payload = await buildPushPayload(
    {
      data,
      options: {
        ttl: 12 * 60 * 60, // 폰이 꺼져 있으면 12시간까지 보관 후 폐기
        urgency: 'normal',
      },
    },
    subscription,
    vapid,
  );

  // payload 는 { method, headers, body } 형태라 fetch 에 그대로 넘긴다
  return fetch(subscription.endpoint, payload);
}
