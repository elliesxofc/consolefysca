// FYSC Console service worker.
//
// Network-first for the app's own files, so an online phone always runs the
// latest version and nobody has to remember to bump a cache version to push
// a fix. The cache is only a fallback that lets the shell open offline.
//
// Requests to the fysca server (a different origin) are never intercepted,
// so live counts and admin actions can't be served stale or replayed.

const CACHE_VERSION = 'fysc-console-v2';

// Relative to this file, so the app works from any path on its host.
const SHELL_FILES = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'config.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Other origins (the fysca server) and the admin API, if it ever ends up
  // on this origin, go straight to the network untouched.
  if (url.origin !== self.location.origin || url.pathname.includes('/admin/api/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) =>
          cached || (request.mode === 'navigate' ? caches.match('./') : Response.error())
        )
      )
  );
});
