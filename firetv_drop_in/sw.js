// Service worker for Mom's call alerts. It wakes when the server sends a push,
// even if the Mom's Call app is closed, and shows a notification that opens it.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  // Browsers require a visible notification for every push, so always show one.
  event.waitUntil(self.registration.showNotification(data.title || 'Your family is calling', {
    body: data.body || 'Tap to answer.',
    tag: 'call',
    renotify: true,
    requireInteraction: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [400, 200, 400, 200, 400],
    data: {url: data.url || '/mom'}
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/mom', self.location.origin);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const client of windows) {
      if (new URL(client.url).pathname === target.pathname && 'focus' in client) return client.focus();
    }
    return self.clients.openWindow(target.href);
  })());
});
