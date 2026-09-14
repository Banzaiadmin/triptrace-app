/*
 * sw.js — app-shell cache.
 *
 * Scope is deliberately narrow: the shell is cached so the app opens instantly and still opens
 * with no signal, showing the last trip from localStorage. API responses are never cached —
 * serving a stale trace as if it were current is exactly the failure this project can't have.
 * Parsing a new trip needs a connection, and the UI says so.
 */

// Bump ASSET_VERSION (and the ?v= query in index.html) on every deploy that changes app.js or
// styles.css. Without it a browser can serve a cached shell against new HTML — which on this app
// would mean a pilot running an old model against a new interface.
const ASSET_VERSION = "10";
const CACHE = `triptrace-shell-v${ASSET_VERSION}`;
const SHELL = [
  "./",
  "index.html",
  `styles.css?v=${ASSET_VERSION}`,
  `app.js?v=${ASSET_VERSION}`,
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  // The on-device analysis core and the sample pairings: with these cached, pasted text and the
  // samples produce a full report with no connection at all. Module imports are unversioned, so
  // the server marks core/* no-cache and this cache is replaced wholesale on a version bump.
  `samples.json?v=${ASSET_VERSION}`,
  `pdf.js?v=${ASSET_VERSION}`,
  `ocr.js?v=${ASSET_VERSION}`,
  "core/engine.js",
  "core/summary.js",
  "core/parser.js",
  "core/scorer.js",
  "core/report.js",
  "core/constants.js",
  "core/py.js",
  "core/tz.js",
  "core/wearables.js",
  "core/revisions.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname.startsWith("/api/")) return;

  // Network-first so a redeploy is picked up immediately; cache is the offline floor.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match("index.html"))),
  );
});
