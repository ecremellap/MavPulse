/*
 * MavPulse service worker: makes the app installable and lets the app
 * shell open offline. Live data (weather, NWS, reports, map tiles) always
 * goes to the network; only the app's own files are cached.
 */
const CACHE = "mavpulse-v9";
const SHELL = [
  "./", "./index.html", "./style.css", "./script.js", "./logic.js", "./data.js", "./store.js", "./citydata.js", "./parking-areas.js",
  "./firebase-config.js", "./manifest.webmanifest", "./vendor/leaflet/leaflet.js", "./vendor/leaflet/leaflet.css",
  "./icons/icon-192.png", "./icons/icon-512.png"
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first for our own files (so updates show up), cache as offline fallback.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then(list => list.length ? list[0].focus() : self.clients.openWindow("./")));
});
