// Service worker: makes the app open instantly and work with no signal.
//
// Bump VERSION on any change to the shell files, or browsers keep serving the
// old copy. There is no build step to do it automatically.
const VERSION = 'v20';
const SHELL = `shell-${VERSION}`;
const TILES = 'tiles-v1';
const MAX_TILES = 400;          // roughly a city at a couple of zoom levels

const LOCAL = [
  './', './index.html', './style.css', './app.js', './logic.js', './providers.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png',
  './data/airports.json',
];
const CDN = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// Live lookups. Never cached: a stale timetable is worse than an honest error.
const LIVE = new Set([
  'photon.komoot.io', 'nominatim.openstreetmap.org', 'api.transitous.org', 'api.open-meteo.com',
]);

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(LOCAL);
    // Individually, so one unreachable CDN cannot fail the whole install.
    await Promise.allSettled(CDN.map(u => cache.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, TILES]);
    await Promise.all((await caches.keys()).filter(k => !keep.has(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (LIVE.has(url.hostname)) return;                       // straight to the network
  if (url.hostname === 'tile.openstreetmap.org') return e.respondWith(tile(request));
  e.respondWith(shellFirst(request));
});

/** Cache-first for anything that makes up the app itself. */
async function shellFirst(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res.ok && (res.type === 'basic' || res.type === 'cors')) cache.put(request, res.clone());
    return res;
  } catch (err) {
    // Offline and never seen this URL. For a page load, the shell will do.
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

/** Map tiles: cache-first, capped so a long trip cannot fill the device. */
async function tile(request) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) {
    await cache.put(request, res.clone());
    const keys = await cache.keys();
    // Oldest-first eviction; cache.keys() preserves insertion order.
    await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_TILES)).map(k => cache.delete(k)));
  }
  return res;
}
