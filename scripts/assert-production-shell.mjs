import { existsSync, readFileSync } from "node:fs";

const htmlPath = new URL("../dist/public/index.html", import.meta.url);
const serviceWorkerPath = new URL("../dist/public/sw.js", import.meta.url);
const html = readFileSync(htmlPath, "utf8");

for (const forbiddenMarker of ["manus-runtime", "__MANUS_HOST_DEV__", "__manus__"]) {
  if (html.includes(forbiddenMarker)) {
    throw new Error(`Production HTML contains a forbidden legacy marker: ${forbiddenMarker}`);
  }
}

if (!existsSync(serviceWorkerPath)) {
  throw new Error("Offline service worker is missing from the production build.");
}

console.log("Production HTML is free of legacy Manus markers and retains the offline service worker.");
