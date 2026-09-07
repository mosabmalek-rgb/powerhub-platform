#!/usr/bin/env node

const baseUrl = (process.env.POWERHUB_PRODUCTION_URL || "https://powerhub-platform.vercel.app/").replace(/\/$/, "");
const routes = ["/", "/login", "/portal", "/404"];

function fail(message) {
  console.error(`P5.6 SMOKE FAILED: ${message}`);
  process.exitCode = 1;
}

async function main() {
  console.log(`P5.6 production smoke: ${baseUrl}`);

  let rootHtml = "";

  for (const route of routes) {
    const url = `${baseUrl}${route}`;
    const response = await fetch(url, { redirect: "manual" });
    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();

    if (response.status !== 200) {
      fail(`${route} returned HTTP ${response.status}`);
      continue;
    }

    if (!contentType.includes("text/html")) {
      fail(`${route} returned unexpected content-type ${contentType}`);
      continue;
    }

    if (!body.toLowerCase().includes("powerhub")) {
      fail(`${route} HTML does not contain the PowerHub application marker`);
      continue;
    }

    console.log(`PASS ${route} -> ${response.status}`);

    if (route === "/") rootHtml = body;
  }

  const assetMatch = rootHtml.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i);
  if (!assetMatch) {
    fail("root page does not expose a module script asset");
  } else {
    const assetPath = assetMatch[1];
    const assetUrl = new URL(assetPath, `${baseUrl}/`).toString();
    const assetResponse = await fetch(assetUrl, { redirect: "manual" });
    if (assetResponse.status !== 200) {
      fail(`primary module asset returned HTTP ${assetResponse.status}`);
    } else {
      console.log(`PASS primary module asset -> ${assetResponse.status}`);
    }
  }

  if (process.exitCode) process.exit(process.exitCode);
  console.log("P5.6 production smoke gate PASSED");
}

main().catch(error => {
  fail(error instanceof Error ? error.message : String(error));
});
