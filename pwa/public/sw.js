// Service worker: offline caching for the Autopilot PWA.
// Strategy:
//   * static assets (same-origin, non-API): cache-first with runtime caching
//   * /api calls: network-first, fall back to cached copy (offline viewing)
//   * navigations: serve cached / when offline

const CACHE = 'autopilot-v1'
const API_CACHE = 'autopilot-api-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg'])))
  self.skipWaiting()
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

  if (url.pathname.startsWith('/api/')) {
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
      fetch(req).catch(() => caches.match('/').then((m) => m ?? Response.error()))
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
