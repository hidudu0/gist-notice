// ===========================================================
//  Service Worker
//
//  페이지가 닫혀 있어도 백그라운드에 살아 있는 스크립트.
//  푸시를 받아 알림을 띄우는 게 유일한 일이다.
//
//  일반 JS 와 스코프가 다르다:
//    - window, document 가 없다 (화면을 못 만진다)
//    - 대신 self, registration, clients 를 쓴다
// ===========================================================

// 배포 직후 새 버전이 바로 활성화되도록 (기본은 다음 방문까지 대기)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  // 서버가 보낸 { title, body, url } 을 꺼낸다.
  // 혹시 형식이 깨져도 알림은 반드시 띄워야 하므로 기본값을 둔다.
  let data = { title: 'GIST 학사공지', body: '새 공지가 있습니다', url: '/' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* 무시하고 기본값 사용 */
  }

  // ★ push 를 받으면 반드시 알림을 띄워야 한다.
  //   iOS 는 조용한 푸시를 허용하지 않고, 안 띄우면 구독을 회수한다.
  //   waitUntil 로 감싸야 알림이 뜨기 전에 워커가 잠들지 않는다.
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: data.url,
      tag: 'gist-notice',       // 같은 tag 는 덮어쓴다 (알림 도배 방지)
      renotify: true,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data || '/';

  event.waitUntil(
    // 이미 열린 창이 있으면 그걸 앞으로, 없으면 새로 연다
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) return w.focus().then(() => w.navigate?.(url));
      }
      return self.clients.openWindow(url);
    }),
  );
});
