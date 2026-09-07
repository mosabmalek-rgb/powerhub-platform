#!/usr/bin/env node

const baseUrl = (process.env.POWERHUB_PRODUCTION_URL || "https://powerhub-platform.vercel.app/").replace(/\/$/, "");

function fail(message) {
  console.error(`P6 SCALE/OPS SMOKE FAILED: ${message}`);
  process.exitCode = 1;
}

async function expectJson(route, expectedStatus) {
  const response = await fetch(`${baseUrl}${route}`, { redirect: "manual", cache: "no-store" });
  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();

  if (response.status !== expectedStatus) {
    fail(`${route} returned HTTP ${response.status}; expected ${expectedStatus}`);
    return null;
  }
  if (!contentType.includes("application/json")) {
    fail(`${route} returned unexpected content-type ${contentType}`);
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    fail(`${route} did not return valid JSON`);
    return null;
  }
}

async function main() {
  console.log(`P6 scale/operations smoke: ${baseUrl}`);

  const health = await expectJson("/api/health", 200);
  if (health?.status !== "ok" || health?.service !== "powerhub-platform") {
    fail("/api/health payload is invalid");
  } else {
    console.log("PASS /api/health");
  }

  const readyResponse = await fetch(`${baseUrl}/api/ready`, { redirect: "manual", cache: "no-store" });
  const readyContentType = readyResponse.headers.get("content-type") || "";
  const readyBody = await readyResponse.text();
  if (readyResponse.status !== 200) {
    fail(`/api/ready returned HTTP ${readyResponse.status}`);
  } else if (!readyContentType.includes("application/json")) {
    fail(`/api/ready returned unexpected content-type ${readyContentType}`);
  } else {
    try {
      const ready = JSON.parse(readyBody);
      if (ready.status !== "ok" || ready.checks?.application !== true || ready.checks?.supabaseConfig !== true) {
        fail("/api/ready payload reports an unhealthy application");
      } else {
        console.log("PASS /api/ready");
      }
    } catch {
      fail("/api/ready did not return valid JSON");
    }
  }

  if (process.exitCode) process.exit(process.exitCode);
  console.log("P6 scale/operations smoke gate PASSED");
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
