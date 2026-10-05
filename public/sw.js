// Prescription Meditation: keeps a copy of the app so it opens without internet, and always fetches the newest version when online.
const C = 'rx-meditation-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== C).map((x) => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return; // only this website's own files
  if (r.mode === 'navigate') { // pages: newest first, saved copy when offline
    e.respondWith(fetch(r).then((res) => { const cp = res.clone(); caches.open(C).then((c) => c.put(r, cp)); return res; })
      .catch(() => caches.match(r).then((m) => m || caches.match('./'))));
    return;
  }
  // pictures and other files: saved copy straight away, refreshed in the background
  e.respondWith(caches.match(r).then((m) => {
    const f = fetch(r).then((res) => { if (res && res.ok) { const cp = res.clone(); caches.open(C).then((c) => c.put(r, cp)); } return res; }).catch(() => m);
    return m || f;
  }));
});
