/*
 * Service worker for Dubai Mall Online delivery ops.
 *
 * Design goal: make the app INSTALLABLE (a real standalone home-screen app on
 * iOS/Android) WITHOUT ever serving a stale operational screen while online.
 * The app is online-first - orders, scans and statuses must reflect the server
 * immediately - so this worker is deliberately NETWORK-FIRST:
 *
 *   - Navigations and same-origin static assets are fetched from the network
 *     first; the cache is only a fallback for a brief offline moment. When the
 *     device has the mall Wi-Fi (the normal case) the picker always gets the
 *     freshest deployed bundle.
 *   - Cross-origin requests (Supabase API, auth) are never touched - they pass
 *     straight through to the network, so data is never cached or staled.
 *   - On activate, old caches are purged and the new worker takes control
 *     immediately, so a deploy can never leave an old bundle running.
 *
 * The offline fallback exists only so the app shell still opens (and can show
 * a "you're offline" state) if Wi-Fi drops for a moment; it is not an offline
 * mode for doing operational work.
 */
const CACHE = 'dbo-shell-v1';
const OFFLINE_URL = '/';

self.addEventListener('install', (event) => {
  // Warm the shell so the very first offline navigation still resolves.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(OFFLINE_URL))
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    // Only cache good, basic (same-origin) responses.
    if (fresh && fresh.ok && fresh.type === 'basic') {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // For a navigation with nothing cached, fall back to the shell.
    if (request.mode === 'navigate') {
      const shell = await cache.match(OFFLINE_URL);
      if (shell) return shell;
    }
    throw new Error('offline and not cached');
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never interfere with non-GET or cross-origin (Supabase/auth) traffic.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(request));
});
