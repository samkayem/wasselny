// sw.js — Service Worker لاستقبال إشعارات الدفع وعرضها حتى عندما يكون التطبيق مغلقاً

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    data = { title: 'Wasselny', body: event.data ? event.data.text() : '' };
  }

  const tasks = [
    self.registration.showNotification(data.title || 'Wasselny', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      silent: false, // يطلب صوت النظام الافتراضي (لا يوجد دعم لنغمة مخصصة في أي متصفح)
      data: { url: data.url || '/driver.html' }
    })
  ];

  // عداد على أيقونة التطبيق (يعمل فعلياً على آيفون iOS 16.4+، ويُتجاهل بأمان إن لم يكن مدعوماً)
  if ('setAppBadge' in self.navigator) {
    tasks.push(self.navigator.setAppBadge(1));
  }

  event.waitUntil(Promise.all(tasks));
});

// عند الضغط على الإشعار: فتح صفحة السائق، أو التركيز عليها إن كانت مفتوحة أصلاً، وتصفير العداد
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/driver.html';

  if ('clearAppBadge' in self.navigator) {
    self.navigator.clearAppBadge();
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if (client.url.includes('driver.html') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
