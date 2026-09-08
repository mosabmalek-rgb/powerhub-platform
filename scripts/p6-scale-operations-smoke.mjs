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

  const ready = await expectJson("/api/ready", 200);
  if (
    ready?.status !== "ok" ||
    ready?.checks?.application !== true ||
    ready?.checks?.supabaseConfig !== true ||
    ready?.checks?.supabaseConnectivity !== true
  ) {
    fail("/api/ready payload reports an unhealthy application or Supabase dependency");
  } else {
    console.log("PASS /api/ready");
  }

  if (process.exitCode) process.exit(process.exitCode);
  console.log("P6 scale/operations smoke gate PASSED");
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
