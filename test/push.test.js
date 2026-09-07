// 푸시 발송의 암호화 + VAPID 서명이 실제로 도는지 확인한다.
// 네트워크로 보내지는 않는다 — 보내기 직전의 payload 가 제대로 만들어지는지만 본다.
//
// 이 테스트가 잡아주는 것: 라이브러리 업그레이드로 API 가 바뀌거나,
// VAPID 키 형식이 틀어져서 발송이 통째로 죽는 경우.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { buildPushPayload } from '@block65/webcrypto-web-push';

// 브라우저가 만들어주는 것과 같은 모양의 키를 직접 만든다
function 가짜구독() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const p256dh = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/fake-endpoint-for-test',
    expirationTime: null,
    keys: { p256dh, auth: randomBytes(16).toString('base64url') },
  };
}

function 가짜VAPID() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const publicKey = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
  return { subject: 'mailto:test@example.com', publicKey, privateKey: jwk.d };
}

test('알림 payload 를 암호화하고 서명한다', async () => {
  const payload = await buildPushPayload(
    {
      data: { title: '[학사] 테스트', body: '2026-09-07', url: 'https://example.com' },
      options: { ttl: 60 },
    },
    가짜구독(),
    가짜VAPID(),
  );

  assert.equal(payload.method.toUpperCase(), 'POST');

  // RFC 8291: 본문은 aes128gcm 으로 암호화된다
  assert.equal(payload.headers['content-encoding'], 'aes128gcm');

  // RFC 8292: VAPID 스킴이어야 한다. 1.x 의 'WebPush' 스킴은 Apple 이 거부한다.
  assert.match(payload.headers.authorization, /^vapid t=.+, k=.+/);

  // 본문이 실제로 암호화돼 있어야 한다 (평문이 새어나오면 안 됨)
  const body = Buffer.from(payload.body);
  assert.ok(body.length > 0);
  assert.ok(!body.includes(Buffer.from('테스트')), '본문이 암호화되지 않았다');
});
