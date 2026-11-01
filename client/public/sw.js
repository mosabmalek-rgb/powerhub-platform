const SHELL_CACHE = "powerhub-shell-v8";
const ASSET_CACHE = "powerhub-assets-v7";
const CACHE_PREFIX = "powerhub-";
const APP_SHELL = ["/", "/login", "/workspace", "/manifest.json"];

function isApiOrServiceWorker(url) {
  return url.pathname.startsWith("/api/") || url.pathname === "/sw.js";
}

function isPublicInvoiceNavigation(url) {
  // Share tokens live in the path. Never cache token-bearing navigation HTML
  // or return a stale shell for a shared invoice after a slow network fetch.
  return /^\/invoice\/[^/]+\/?$/.test(url.pathname);
}

function isCacheableStaticAsset(url) {
  // Cache only immutable build assets and public shell files, never API data,
  // uploaded receipts, profile photos, or user-specific resources.
  return url.pathname.startsWith("/assets/") ||
    ["/manifest.json", "/favicon.ico", "/robots.txt"].includes(url.pathname);
}

function normalizedUrl(value) {
  const url = new URL(value, self.location.origin);
  return new URL(url.pathname, self.location.origin).href;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith(CACHE_PREFIX) &&
          key !== SHELL_CACHE && key !== ASSET_CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || isApiOrServiceWorker(url)) return;
  if (url.pathname.startsWith("/@") || url.pathname.includes("/node_modules/")) return;

  // Let Vercel serve the current HTML directly. Public invoice URLs carry a
  // share token in their pathname, so they must not enter Cache Storage.
  if (request.mode === "navigate" && isPublicInvoiceNavigation(url)) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const response = await fetch(request, { cache: "no-store" });
        if (response.ok && (response.headers.get("content-type") || "").includes("text/html")) {
          // Keep only a generic SPA shell key; do not persist query strings/tokens.
          await cache.put(normalizedUrl(request.url), response.clone());
        }
        return response;
      } catch {
        const cached = await cache.match(normalizedUrl(request.url));
        return cached || await cache.match("/workspace") || await cache.match("/");
      }
    })());
    return;
  }

  if (!isCacheableStaticAsset(url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(ASSET_CACHE);
    const key = normalizedUrl(request.url);
    const cached = await cache.match(key);
    const refresh = fetch(request, { cache: "no-store" })
      .then(async (response) => {
        if (response.ok && response.type !== "opaque") await cache.put(key, response.clone());
        return response;
      })
      .catch(() => null);
    if (cached) {
      event.waitUntil(refresh.then(() => undefined));
      return cached;
    }
    return await refresh || Response.error();
  })());
});
