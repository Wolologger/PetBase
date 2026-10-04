/* PetBase · service worker mínimo: la app abre sin conexión. Los datos NO se cachean aquí (viven en el almacenamiento de la app y en Firestore).
   Las páginas y scripts se piden primero a la red (así siempre ves la última versión) y solo se usa la copia si no hay conexión. */
const V = 'petbase-v1.1.0', SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './icon-maskable-192.png', './icon-maskable-512.png', './apple-touch-icon.png', './firebase-config.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;          // Firebase y fuentes van directas a la red
  const fresh = e.request.mode === 'navigate' || /\.(html|js|json|md)$/.test(u.pathname) || u.pathname.endsWith('/');
  e.respondWith(caches.open(V).then(async c => {
    if (fresh) {
      try { const r = await fetch(e.request, { cache: 'no-store' }); if (r.ok) c.put(e.request, r.clone()); return r; }
      catch (err) { return (await c.match(e.request)) || (await c.match('./index.html')) || Response.error(); }
    }
    const hit = await c.match(e.request);
    return hit || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; });
  }));
});
