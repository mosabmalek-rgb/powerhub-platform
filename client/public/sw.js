const SHELL_CACHE = "powerhub-shell-v5";
const ASSET_CACHE = "powerhub-assets-v5";
const CACHE_PREFIX = "powerhub-";
const APP_SHELL = ["/", "/login", "/workspace", "/manifest.json"];
const NAVIGATION_TIMEOUT_MS = 2_500;

function isApiOrServiceWorker(url) {
  return url.pathname.startsWith("/api/") || url.pathname === "/sw.js";
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

async function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
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

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const response = await fetchWithTimeout(request, NAVIGATION_TIMEOUT_MS);
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
