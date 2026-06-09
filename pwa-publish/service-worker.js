/**
 * service-worker.js — PWA Service Worker
 *
 * Strategy: Cache-First for app shell assets, Network-First for CDN resources.
 *
 * On install  → pre-cache all app shell files.
 * On activate → delete stale caches from previous versions.
 * On fetch    → serve from cache when available; fall back to network.
 */

'use strict';

// Bump this version string whenever you update any cached file so that
// the old cache is discarded and users get fresh assets.
const CACHE_VERSION = 'patient-pwa-v090620261150';

// ─── App shell files to pre-cache ────────────────────────────────────────
// These are the minimum files needed to run offline after the first visit.
const APP_SHELL = [
  './',                   // resolves to index.html
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  // sql.js files (CDN) — cached so the app works fully offline
  'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js',
  'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.wasm'
];

// ─── Install: pre-cache the app shell ────────────────────────────────────

self.addEventListener('install', (event) => {
  console.log('[SW] Install — caching app shell');

  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      // Fetch same-origin app shell files with cache:'reload' so the browser
      // always pulls a fresh copy from the network, bypassing any HTTP cache.
      // This prevents the new SW from pre-caching a stale app.js / index.html
      // that may still be within its max-age window on the client.
      // CDN resources (sql.js) use the default mode — they're versioned URLs
      // so HTTP cache hits are always correct.
      const appShellRequests = APP_SHELL.map((url) =>
        url.startsWith('http')
          ? url                                            // CDN — use default
          : new Request(url, { cache: 'reload' })         // same-origin — always fresh
      );
      return cache.addAll(appShellRequests);
    })
  );

  // Skip the waiting phase so the new SW activates immediately.
  self.skipWaiting();
});

// ─── Activate: remove outdated caches ────────────────────────────────────

self.addEventListener('activate', (event) => {
  console.log('[SW] Activate — pruning old caches');

  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_VERSION)   // keep only current version
          .map((name) => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      )
    )
  );

  // Take control of all open tabs immediately (no reload required).
  self.clients.claim();
});

// ─── Fetch: serve from cache, fall back to network ───────────────────────

self.addEventListener('fetch', (event) => {
  // We only handle GET requests; skip non-GET (e.g. POST to an API).
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {

      if (cachedResponse) {
        // Cache hit — return the cached response immediately.
        return cachedResponse;
      }

      // Cache miss — fetch from the network and cache the response for next time.
      return fetch(event.request)
        .then((networkResponse) => {
          // Cache valid same-origin responses (type 'basic').
          // Opaque cross-origin responses are pre-cached in APP_SHELL, not here.
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            networkResponse.type === 'basic'
          ) {
            // Clone the response because it can only be consumed once.
            const responseToCache = networkResponse.clone();

            caches.open(CACHE_VERSION).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }

          return networkResponse;
        })
        .catch(() => {
          // Network request failed and no cache available.
          // Return a simple offline fallback for HTML navigation requests.
          if (event.request.headers.get('accept')?.includes('text/html')) {
            return caches.match('./index.html');
          }
          // For other resource types, just fail silently.
        });
    })
  );
});
