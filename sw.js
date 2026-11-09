// Offline support: the app shell is cached on install; map tiles you've viewed are kept for offline use.
const VERSION = 'mio-v8';
const TILES = 'mio-tiles';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'engine.js', 'leaflet.js', 'leaflet.css', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== TILES).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App files: answer from cache immediately, refresh the cache in the background.
  if (url.origin === self.location.origin) {
    e.respondWith(caches.open(VERSION).then(async cache => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }

  // Esri map tiles: network first, fall back to tiles seen before.
  if (url.hostname === 'server.arcgisonline.com') {
    e.respondWith(caches.open(TILES).then(async cache => {
      try {
        const res = await fetch(req);
        if (res.ok) { cache.put(req, res.clone()); trim(cache); }
        return res;
      } catch (err) {
        const hit = await cache.match(req);
        if (hit) return hit;
        throw err;
      }
    }));
  }
  // Everything else (Google Maps etc.) goes straight to the network.
});

let trimming = false;
async function trim(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    if (keys.length > 1500) for (const k of keys.slice(0, keys.length - 1200)) await cache.delete(k);
  } finally { trimming = false; }
}
