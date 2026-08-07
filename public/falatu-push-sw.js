/**
 * ADR-154 F8.3 — handler de Web Push do FalaTu.
 *
 * Este arquivo NÃO é um service worker próprio: é puxado pro SW gerado pelo
 * vite-plugin-pwa via `workbox.importScripts` (vite.config.ts). A decisão da
 * ADR-082 fica intacta — o SW continua sem cache de API; aqui só reagimos a
 * eventos de push (que chegam mesmo com o app fechado).
 */
self.addEventListener('push', (event) => {
  let data = { title: 'FalaTu', body: 'Você tem novidades.', url: '/' };
  try { data = { ...data, ...event.data.json() }; } catch { /* payload não-JSON → defaults */ }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/brand/favicon-192x192.png',
      badge: '/brand/favicon-192x192.png',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) { if ('focus' in w) return w.focus(); }
      return self.clients.openWindow(url);
    })
  );
});
