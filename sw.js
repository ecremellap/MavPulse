/*
 * MavPulse service worker: makes the app installable and lets the app
 * shell open offline. External services and map tiles still need a network;
 * the app separately saves a snapshot of recent campus data on the device.
 */
const CACHE = "mavpulse-v30";
const SHELL = [
  "./", "./index.html", "./style.css", "./script.js", "./logic.js", "./data.js", "./store.js", "./citydata.js", "./libraries.js", "./parking-areas.js", "./detours.js",
  "./firebase-config.js", "./manifest.webmanifest", "./vendor/leaflet/leaflet.js", "./vendor/leaflet/leaflet.css",
  "./vendor/leaflet/images/layers.png", "./vendor/leaflet/images/layers-2x.png",
  "./vendor/leaflet/images/marker-icon.png", "./vendor/leaflet/images/marker-icon-2x.png", "./vendor/leaflet/images/marker-shadow.png",
  "./icons/favicon-64.png", "./icons/apple-touch-icon.png", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png", "./icons/invite-qr.svg"
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("mavpulse-v") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// The versioned shell cache serves the app immediately without a network.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cached = await caches.match(e.request);
    if (cached) return cached;
    try {
      const response = await fetch(e.request);
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(e.request, response.clone());
      }
      return response;
    } catch (error) {
      if (e.request.mode === "navigate") {
        const app = await caches.match("./index.html");
        if (app) return app;
      }
      return new Response("This resource is not available offline.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }
  })());
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
