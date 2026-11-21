// Service worker for the hosted version (GitHub Pages): keeps the tool usable
// without a connection once it has been opened once.
//
// Strategy: network first (so a new version is picked up as soon as the
// network answers), cache as fallback (offline, or no answer within 4 s).
// The list below must contain every file the page loads; test/pwa.test.js
// checks it against the repository.

const CACHE = 'pairing-40k';

const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'src/advisor.js',
  'src/engine.js',
  'src/matrix.js',
  'src/matrixgame.js',
  'src/pairing.js',
  'src/rules.js',
  'src/shared.js',
  'src/ui.js',
  'src/worker.js',
  'assets/fonts/fonts.css',
  'assets/fonts/barlow-condensed-latin-500-normal.woff2',
  'assets/fonts/barlow-condensed-latin-600-normal.woff2',
  'assets/fonts/barlow-condensed-latin-700-normal.woff2',
  'assets/fonts/ibm-plex-mono-latin-400-normal.woff2',
  'assets/fonts/ibm-plex-mono-latin-500-normal.woff2',
  'assets/fonts/ibm-plex-sans-latin-400-normal.woff2',
  'assets/fonts/ibm-plex-sans-latin-500-normal.woff2',
  'assets/fonts/ibm-plex-sans-latin-600-normal.woff2',
  'assets/icons/icon.svg',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png',
];

const TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function fromNetwork(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
    fetch(request).then((response) => {
      clearTimeout(timer);
      resolve(response);
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function fromCache(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  if (request.mode === 'navigate') return cache.match('index.html');
  return Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const response = await fromNetwork(request);
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    } catch {
      return fromCache(request);
    }
  })());
});
