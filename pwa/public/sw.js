// Service worker: offline caching for the Autopilot PWA.
// Strategy:
//   * static assets (same-origin, non-API): cache-first with runtime caching
//   * API calls under the app scope: network-first, fall back to cached copy
//   * navigations: serve the cached app shell when offline
//
// The app can be hosted at the domain root (Netlify) or under a subpath
// (GitHub Pages project site, e.g. /dain-T-Bot/). Instead of absolute
// paths, everything is resolved relative to this worker's registration
// scope, so the same worker works in both layouts. When the engine runs on
// a different origin (GitHub Pages hosting with the API on Netlify), those
// cross-origin requests are ignored by this worker - the live data simply
// comes straight from the network.

const CACHE = 'autopilot-v2'
const API_CACHE = 'autopilot-api-v2'
// Scope pathname of this worker: '/' at a domain root, '/dain-T-Bot/' on a
// GitHub Pages project site. Always ends with a slash.
const ROOT = new URL(self.registration.scope).pathname

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll([ROOT, ROOT + 'manifest.webmanifest', ROOT + 'icon.svg'])),
    self.skipWaiting()
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== API_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  if (url.pathname.startsWith(ROOT + 'api/')) {
    // network-first, offline fallback for cached data
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(API_CACHE).then((c) => c.put(req, copy)).catch(() => {})
          return res
        })
        .catch(() => caches.match(req).then((m) => m ?? new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } })))
    )
    return
  }

  if (req.mode === 'navigate') {
    // navigation: network-first, fall back to cached shell
    event.respondWith(
      fetch(req).catch(() => caches.match(ROOT).then((m) => m ?? Response.error()))
    )
    return
  }

  // static assets: cache-first
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
          return res
        })
    )
  )
})
