const CACHE_NAME = "powerhub-shell-v2";
const APP_SHELL = ["/"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone();
      void caches.open(CACHE_NAME).then((cache) => cache.put("/", copy));
      return response;
    }).catch(() => caches.match("/")));
    return;
  }
  // Never cache Vite development modules or other versioned runtime assets.
  // An old React module can otherwise survive a hot reload and conflict with
  // the current ReactDOM dispatcher.
  if (url.pathname.startsWith("/@") || url.pathname.includes("/node_modules/") || url.searchParams.has("v")) return;

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
