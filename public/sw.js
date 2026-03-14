/* ============================================================
   ChatApp Service Worker
   - Cache shell assets untuk offline
   - Handle Push Notification
   - Background sync untuk pesan yang gagal terkirim
   ============================================================ */

const CACHE_NAME = 'chatapp-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

/* ── INSTALL ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] Cache addAll partial fail:', err);
      });
    })
  );
  self.skipWaiting();
});

/* ── ACTIVATE ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/* ── FETCH — Network first, cache fallback ── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET, socket.io, API calls, uploads
  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/socket.io')) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/uploads/')) return;

  // For navigation requests (HTML pages) — network first
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => {
          // Cache fresh copy
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // For static assets — cache first
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
        }
        return res;
      }).catch(() => cached);
    })
  );
});

/* ── PUSH NOTIFICATION ── */
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'ChatApp', body: event.data ? event.data.text() : 'Pesan baru' };
  }

  const title   = data.title   || 'ChatApp';
  const body    = data.body    || 'Kamu punya pesan baru';
  const icon    = data.icon    || '/icons/icon-192.png';
  const badge   = data.badge   || '/icons/icon-96.png';
  const tag     = data.tag     || 'chatapp-msg';
  const url     = data.url     || '/';
  const sender  = data.sender  || '';
  const roomId  = data.roomId  || '';

  const options = {
    body,
    icon,
    badge,
    tag,
    data: { url, roomId, sender },
    vibrate: [200, 100, 200],
    requireInteraction: false,
    silent: false,
    actions: [
      { action: 'open',  title: 'Buka Chat' },
      { action: 'close', title: 'Tutup'     },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

/* ── NOTIFICATION CLICK ── */
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'close') return;

  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Focus existing window if open
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          client.postMessage({ type: 'NOTIFICATION_CLICK', url, data: event.notification.data });
          return;
        }
      }
      // Open new window
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

/* ── NOTIFICATION CLOSE ── */
self.addEventListener('notificationclose', event => {
  // Analytics / tracking can go here
});

/* ── MESSAGE from page ── */
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'CACHE_URLS') {
    caches.open(CACHE_NAME).then(cache => cache.addAll(event.data.urls || []));
  }
});
