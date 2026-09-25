// Shows the notifications the server sends (server/push.ts) and opens the right channel when one is
// tapped. It deliberately has no fetch handler and caches nothing, so every deploy still reaches
// everyone straight away.

// A new version of this file takes over at once instead of waiting for every tab to close.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* Show the app's name at least. */ }
  event.waitUntil(self.registration.showNotification(data.title || 'Majlis', {
    body: data.body || '',
    // A channel's notifications replace each other instead of piling up, and each new one still alerts.
    tag: data.tag,
    renotify: Boolean(data.tag),
    icon: '/icon-192.png',
    dir: 'auto',
    data: { url: data.url || '/', channelId: data.channelId || null },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { url, channelId } = event.notification.data || {};
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = pages.find(client => new URL(client.url).origin === self.location.origin);
    // An open app switches to the channel; otherwise the app opens on it.
    if (page) {
      page.postMessage({ type: 'open-channel', channelId });
      return page.focus();
    }
    return self.clients.openWindow(new URL(url || '/', self.location.origin).href);
  })());
});
