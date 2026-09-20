#!/usr/bin/env node

const baseUrl = (process.env.POWERHUB_PRODUCTION_URL || "https://powerhub-platform.vercel.app").replace(/\/$/, "");
const stages = [50, 100, 250, 500];
const timeoutMs = Number(process.env.LOADTEST_TIMEOUT_MS || 15000);

const routes = [
  { path: "/api/ready", weight: 40 },
  { path: "/api/health", weight: 20 },
  { path: "/", weight: 15 },
  { path: "/login", weight: 15 },
  { path: "/portal", weight: 10 },
];

function weightedRoute(index) {
  const total = routes.reduce((sum, route) => sum + route.weight, 0);
  const bucket = (index * 7919 + 17) % total;
  let cursor = 0;
  for (const route of routes) {
    cursor += route.weight;
    if (bucket < cursor) return route.path;
  }
  return routes[routes.length - 1].path;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

async function timedRequest(path, index) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const url = new URL(path, baseUrl);
    if (path === "/" || path === "/login" || path === "/portal") {
      url.searchParams.set("loadtest", String(Date.now()));
      url.searchParams.set("n", String(index));
    }
    const response = await fetch(url, {
      redirect: "manual",
      cache: "no-store",
      headers: {
        "cache-control": "no-cache",
        "x-powerhub-load-test": "p7-real-http",
      },
      signal: controller.signal,
    });
    const body = await response.arrayBuffer();
    return {
      path,
      status: response.status,
      ok: response.status >= 200 && response.status < 400,
      latencyMs: performance.now() - started,
      bytes: body.byteLength,
    };
  } catch (error) {
    return {
      path,
      status: 0,
      ok: false,
      latencyMs: performance.now() - started,
      bytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runStage(concurrency) {
  const started = performance.now();
  const tasks = Array.from({ length: concurrency }, (_, index) =>
    timedRequest(weightedRoute(index), index)
  );
  const results = await Promise.all(tasks);
  const durationMs = performance.now() - started;
  const latencies = results.map((r) => r.latencyMs);
  const errors = results.filter((r) => !r.ok);
  const statusCounts = {};
  const routeSummary = {};

  for (const result of results) {
    const key = String(result.status);
    statusCounts[key] = (statusCounts[key] || 0) + 1;
    if (!routeSummary[result.path]) {
      routeSummary[result.path] = { requests: 0, errors: 0, p50: null, p95: null, p99: null };
    }
    routeSummary[result.path].requests += 1;
    if (!result.ok) routeSummary[result.path].errors += 1;
  }

  for (const path of Object.keys(routeSummary)) {
    const values = results.filter((r) => r.path === path).map((r) => r.latencyMs);
    routeSummary[path].p50 = percentile(values, 0.50);
    routeSummary[path].p95 = percentile(values, 0.95);
    routeSummary[path].p99 = percentile(values, 0.99);
  }

  return {
    concurrency,
    wallMs: durationMs,
    requests: results.length,
    errorCount: errors.length,
    errorRatePct: (errors.length / results.length) * 100,
    p50Ms: percentile(latencies, 0.50),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    throughputRps: results.length / (durationMs / 1000),
    statusCounts,
    routeSummary,
    sampleErrors: errors.slice(0, 20),
  };
}

async function main() {
  console.log(`P7 REAL HTTP LOAD TEST: ${baseUrl}`);
  console.log(`Stages: ${stages.join(", ")} concurrent HTTP requests`);
  console.log(`Timeout: ${timeoutMs} ms`);

  const results = {
    baseUrl,
    generatedAt: new Date().toISOString(),
    stages: [],
  };

  // Warm-up: 10 requests, not included in metrics.
  await Promise.all(Array.from({ length: 10 }, (_, i) => timedRequest("/api/ready", i)));
  console.log("Warm-up complete");

  for (const concurrency of stages) {
    const stage = await runStage(concurrency);
    results.stages.push(stage);
    console.log(JSON.stringify({
      concurrency: stage.concurrency,
      requests: stage.requests,
      errorRatePct: Number(stage.errorRatePct.toFixed(3)),
      p50Ms: Number(stage.p50Ms.toFixed(2)),
      p95Ms: Number(stage.p95Ms.toFixed(2)),
      p99Ms: Number(stage.p99Ms.toFixed(2)),
      throughputRps: Number(stage.throughputRps.toFixed(2)),
      statusCounts: stage.statusCounts,
    }));
  }

  const maxErrorRate = Math.max(...results.stages.map((s) => s.errorRatePct));
  results.maxErrorRatePct = maxErrorRate;
  results.pass = maxErrorRate < 5;

  await import("node:fs/promises").then((fs) =>
    fs.writeFile("p7-load-results.json", JSON.stringify(results, null, 2))
  );

  console.log("FINAL " + JSON.stringify(results, null, 2));

  if (!results.pass) {
    console.error(`P7 LOAD TEST FAILED: max error rate ${maxErrorRate.toFixed(2)}% >= 5%`);
    process.exitCode = 1;
  } else {
    console.log("P7 LOAD TEST GATE PASSED: error rate remained below 5%");
  }
}

main().catch((error) => {
  console.error("P7 LOAD TEST FAILED:", error);
  process.exitCode = 1;
});
