/*
 * MavPulse service worker: makes the app installable and lets the app
 * shell open offline. Live data (weather, NWS, reports, map tiles) always
 * goes to the network; only the app's own files are cached.
 */
const CACHE = "mavpulse-v20";
const SHELL = [
  "./", "./index.html", "./style.css", "./script.js", "./logic.js", "./data.js", "./store.js", "./citydata.js", "./parking-areas.js", "./detours.js",
  "./firebase-config.js", "./manifest.webmanifest", "./vendor/leaflet/leaflet.js", "./vendor/leaflet/leaflet.css",
  "./icons/icon-192.png", "./icons/icon-512.png"
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first for our own files (so updates show up), cache as offline fallback.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    // "no-cache" revalidates with the server, so a fresh deploy shows up at once.
    fetch(e.request, { cache: "no-cache" }).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.indexOf(self.location.origin) === 0);
    if (open) { open.focus(); if (open.navigate) return open.navigate(url); return undefined; }
    return self.clients.openWindow(url);
  }));
});
