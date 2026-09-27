#!/usr/bin/env node

const target = new URL(process.env.POWERHUB_LOAD_URL ?? "http://127.0.0.1:3000/api/health");
const durationSeconds = Math.min(Math.max(Number(process.env.LOAD_DURATION_SECONDS ?? 30), 1), 900);
const concurrency = Math.min(Math.max(Number(process.env.LOAD_CONCURRENCY ?? 10), 1), 300);
const allowProduction = process.env.ALLOW_PRODUCTION_LOAD === "1";

if (!allowProduction && /(^|\.)vercel\.app$|powerhub-platform/i.test(target.hostname)) {
  throw new Error("رفض اختبار الحمل على Production. استخدم staging أو ALLOW_PRODUCTION_LOAD=1 بقرار تشغيلي صريح.");
}

const deadline = Date.now() + durationSeconds * 1000;
const samples = [];
let ok = 0;
let failed = 0;

async function worker() {
  while (Date.now() < deadline) {
    const started = performance.now();
    try {
      const response = await fetch(target, { headers: { accept: "application/json" } });
      const elapsed = performance.now() - started;
      samples.push(elapsed);
      if (response.ok) ok += 1;
      else failed += 1;
      await response.arrayBuffer();
    } catch {
      samples.push(performance.now() - started);
      failed += 1;
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
samples.sort((a, b) => a - b);
const percentile = (p) => samples.length ? samples[Math.min(samples.length - 1, Math.floor(samples.length * p))] : 0;
const elapsedSeconds = durationSeconds;
console.log(JSON.stringify({
  target: target.toString(),
  durationSeconds: elapsedSeconds,
  concurrency,
  requests: samples.length,
  ok,
  failed,
  requestsPerSecond: Number((samples.length / elapsedSeconds).toFixed(2)),
  latencyMs: {
    p50: Number(percentile(0.5).toFixed(2)),
    p95: Number(percentile(0.95).toFixed(2)),
    p99: Number(percentile(0.99).toFixed(2)),
  },
}, null, 2));
