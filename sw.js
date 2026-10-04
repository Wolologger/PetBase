/* PetBase · service worker mínimo: la app abre sin conexión. Los datos NO se cachean aquí (viven en el almacenamiento de la app y en Firestore). */
const V = 'petbase-v1', SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './firebase-config.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;          // Firebase y fuentes van directas a la red
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(e.request);
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;                                                                // primero la copia, y se refresca en segundo plano
  }));
});
