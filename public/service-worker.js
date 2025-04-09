console.log('서비스 워커 로드됨 / Service Worker Loaded');

self.addEventListener('push', event => {
  console.log('[Service Worker] 푸시 받음 / Push Received.');
  console.log(`[Service Worker] 푸시 데이터: "${event.data.text()}" / Push Data: "${event.data.text()}"`);

  const data = event.data.json(); // 서버에서 보낸 JSON 데이터를 파싱

  const title = data.title || '새 메시지 / Nuevo Mensaje'; // 제목 설정
  const options = {
    body: data.body || '채팅 앱에서 온 새 메시지입니다. / Tienes un nuevo mensaje en la app de chat.', // 내용 설정
    icon: data.icon || '/icons/icon-192x192.png', // 알림 아이콘
    badge: data.badge || '/icons/badge-72x72.png', // 안드로이드에서 상태 표시줄 아이콘
    data: { // 알림 클릭 시 전달할 데이터
         url: data.url || '/' // 클릭 시 이동할 URL
    }
  };

  // 알림 표시!
  event.waitUntil(self.registration.showNotification(title, options));
});

// 알림 클릭 시 동작 정의
self.addEventListener('notificationclick', event => {
  console.log('[Service Worker] 알림 클릭됨 / Notification click Received.');

  event.notification.close(); // 알림 닫기

  // 클라이언트(브라우저 탭)를 찾아서 포커스하거나 새로 열기
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // 열려있는 탭 중에서 해당 URL을 가진 탭 찾기
      const urlToOpen = event.notification.data.url || '/';
      for (const client of clientList) {
        // URL이 같고 포커스가 가능한 탭이 있다면 그 탭으로 이동
        if (client.url === urlToOpen && 'focus' in client) {
          return client.focus();
        }
      }
      // 해당하는 탭이 없으면 새 탭으로 열기
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});