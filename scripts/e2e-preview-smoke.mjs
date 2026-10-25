import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const playwrightHome = process.env.PLAYWRIGHT_HOME;
if (!playwrightHome) throw new Error("PLAYWRIGHT_HOME must point to the isolated Playwright install directory.");
const require = createRequire(path.join(playwrightHome, "p7-preview-smoke-runner.cjs"));
const { chromium } = require("playwright");

const currentBase = (process.env.PREVIEW_URL || "").replace(/\/+$/, "");
const baselineBase = (process.env.BASELINE_URL || "").replace(/\/+$/, "");
const outputPath = process.env.PERFORMANCE_OUTPUT || "artifacts/p7-preview-performance.json";
if (!currentBase) throw new Error("PREVIEW_URL is required.");
if (!baselineBase) throw new Error("BASELINE_URL is required.");

const results = {
  generatedAt: new Date().toISOString(),
  currentBase,
  baselineBase,
  health: {},
  performance: {},
  browserChecks: [],
  errors: [],
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

async function assertHealth(request, base) {
  for (const endpoint of ["/api/health", "/api/ready"]) {
    const response = await request.get(base + endpoint, { timeout: 20000 });
    assert.equal(response.status(), 200, endpoint + " should return HTTP 200 on " + base);
    const body = await response.json();
    assert.equal(body.status, "ok", endpoint + " should report status=ok on " + base);
    if (endpoint === "/api/ready") {
      assert.equal(body.checks?.application, true, "application readiness check should pass");
      assert.equal(body.checks?.supabaseConfig, true, "Supabase config readiness check should pass");
      assert.equal(body.checks?.supabaseConnectivity, true, "Supabase connectivity readiness check should pass");
    }
    results.health[new URL(base).host + endpoint] = { status: response.status(), body };
  }
}

async function measurePage(browser, base, pathname, type) {
  const context = await browser.newContext({
    locale: "ar",
    timezoneId: "Asia/Hebron",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const sameOriginFailures = [];
  const http5xx = [];
  const baseOrigin = new URL(base).origin;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).origin === baseOrigin) {
      sameOriginFailures.push({ url: request.url(), failure: request.failure() });
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 500 && new URL(response.url()).origin === baseOrigin) {
      http5xx.push({ url: response.url(), status: response.status() });
    }
  });

  const startedAt = Date.now();
  const response = await page.goto(base + pathname, { waitUntil: "domcontentloaded", timeout: 45000 });
  assert.ok(response, "navigation to " + pathname + " should produce a response");
  assert.equal(response.status(), 200, pathname + " should return HTTP 200 on " + base);
  await page.locator("#root").waitFor({ state: "attached", timeout: 15000 });
  await page.waitForFunction(() => {
    const root = document.querySelector("#root");
    return Boolean(root && root.childElementCount > 0);
  }, { timeout: 30000 });

  if (type === "login") {
    await page.getByRole("heading", { name: "تسجيل الدخول" }).waitFor({ state: "visible", timeout: 15000 });
    const email = page.getByLabel("البريد الإلكتروني");
    const password = page.getByLabel("كلمة المرور");
    await email.fill("preview-smoke@example.invalid");
    await password.fill("NeverSubmitThisPassword123!");
    assert.equal(await email.inputValue(), "preview-smoke@example.invalid");
    assert.equal(await password.inputValue(), "NeverSubmitThisPassword123!");
    // Never submit this form: the preview smoke test uses no credentials and performs no writes.
  }

  if (type === "protected-route") {
    await page.waitForFunction(() => window.location.pathname === "/login", { timeout: 20000 });
    await page.getByRole("heading", { name: "تسجيل الدخول" }).waitFor({ state: "visible", timeout: 15000 });
  }

  const metrics = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource");
    const origin = location.origin;
    const firstParty = resources.filter((item) => {
      try { return new URL(item.name).origin === origin; } catch { return false; }
    });
    return {
      url: location.href,
      title: document.title,
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
      domContentLoadedMs: Math.round(navigation?.domContentLoadedEventEnd ?? 0),
      loadEventMs: Math.round(navigation?.loadEventEnd ?? 0),
      timeToFirstByteMs: Math.round(navigation?.responseStart ?? 0),
      navigationTransferBytes: navigation?.transferSize ?? 0,
      firstPartyResourceCount: firstParty.length,
      firstPartyTransferBytes: firstParty.reduce((sum, item) => sum + (item.transferSize ?? 0), 0),
      firstPartyEncodedBytes: firstParty.reduce((sum, item) => sum + (item.encodedBodySize ?? 0), 0),
      allResourceCount: resources.length,
    };
  });
  metrics.elapsedFromNavigationStartMs = Date.now() - startedAt;
  metrics.pageErrors = pageErrors;
  metrics.consoleErrors = consoleErrors;
  metrics.sameOriginFailures = sameOriginFailures;
  metrics.http5xx = http5xx;

  assert.equal(metrics.lang, "ar", pathname + " should preserve Arabic document language");
  assert.equal(metrics.dir, "rtl", pathname + " should preserve RTL document direction");
  assert.deepEqual(pageErrors, [], pathname + " should not produce uncaught browser exceptions");
  assert.deepEqual(http5xx, [], pathname + " should not produce same-origin HTTP 5xx responses");
  assert.deepEqual(
    sameOriginFailures.filter((item) => /\.(?:js|css)(?:\?|$)/i.test(item.url)),
    [],
    pathname + " should not fail loading first-party JS/CSS assets",
  );

  await page.close();
  await context.close();
  return metrics;
}

async function sampleRoute(browser, base, pathname, type, repetitions = 3) {
  const samples = [];
  for (let index = 0; index < repetitions; index += 1) {
    samples.push(await measurePage(browser, base, pathname, type));
  }
  const summary = {
    samples,
    medianDomContentLoadedMs: median(samples.map((sample) => sample.domContentLoadedMs)),
    medianLoadEventMs: median(samples.map((sample) => sample.loadEventMs)),
    medianTimeToFirstByteMs: median(samples.map((sample) => sample.timeToFirstByteMs)),
    medianElapsedFromNavigationStartMs: median(samples.map((sample) => sample.elapsedFromNavigationStartMs)),
    medianFirstPartyTransferBytes: median(samples.map((sample) => sample.firstPartyTransferBytes)),
    medianFirstPartyResourceCount: median(samples.map((sample) => sample.firstPartyResourceCount)),
  };
  results.performance[new URL(base).host + pathname] = summary;
  return summary;
}

const browser = await chromium.launch({ headless: true });
try {
  const requestContext = await browser.newContext();
  const request = requestContext.request;
  await assertHealth(request, currentBase);
  await assertHealth(request, baselineBase);
  await requestContext.close();

  const currentRoot = await sampleRoute(browser, currentBase, "/", "home");
  const currentLogin = await sampleRoute(browser, currentBase, "/login", "login");
  const protectedResult = await measurePage(browser, currentBase, "/subscribers", "protected-route");
  results.browserChecks.push({
    kind: "protected-route-redirect",
    status: "passed",
    finalUrl: protectedResult.url,
    elapsedMs: protectedResult.elapsedFromNavigationStartMs,
  });

  const baselineRoot = await sampleRoute(browser, baselineBase, "/", "home");
  const baselineLogin = await sampleRoute(browser, baselineBase, "/login", "login");

  results.comparison = {
    note: "Three fresh browser contexts per route. Timing and Resource Timing byte totals are indicative, not a lab-grade performance budget; network, region, cache, and cross-origin transfer exposure vary.",
    root: {
      baselineMedianDomContentLoadedMs: baselineRoot.medianDomContentLoadedMs,
      currentMedianDomContentLoadedMs: currentRoot.medianDomContentLoadedMs,
      domContentLoadedDeltaMs: currentRoot.medianDomContentLoadedMs - baselineRoot.medianDomContentLoadedMs,
      baselineMedianFirstPartyTransferBytes: baselineRoot.medianFirstPartyTransferBytes,
      currentMedianFirstPartyTransferBytes: currentRoot.medianFirstPartyTransferBytes,
      firstPartyTransferBytesDelta: currentRoot.medianFirstPartyTransferBytes - baselineRoot.medianFirstPartyTransferBytes,
      baselineMedianFirstPartyResourceCount: baselineRoot.medianFirstPartyResourceCount,
      currentMedianFirstPartyResourceCount: currentRoot.medianFirstPartyResourceCount,
    },
    login: {
      baselineMedianDomContentLoadedMs: baselineLogin.medianDomContentLoadedMs,
      currentMedianDomContentLoadedMs: currentLogin.medianDomContentLoadedMs,
      domContentLoadedDeltaMs: currentLogin.medianDomContentLoadedMs - baselineLogin.medianDomContentLoadedMs,
      baselineMedianFirstPartyTransferBytes: baselineLogin.medianFirstPartyTransferBytes,
      currentMedianFirstPartyTransferBytes: currentLogin.medianFirstPartyTransferBytes,
      firstPartyTransferBytesDelta: currentLogin.medianFirstPartyTransferBytes - baselineLogin.medianFirstPartyTransferBytes,
      baselineMedianFirstPartyResourceCount: baselineLogin.medianFirstPartyResourceCount,
      currentMedianFirstPartyResourceCount: currentLogin.medianFirstPartyResourceCount,
    },
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify({ status: "passed", outputPath, comparison: results.comparison }, null, 2));
} catch (error) {
  results.errors.push(error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(results, null, 2) + "\n");
  console.error(JSON.stringify({ status: "failed", outputPath, error: results.errors[0] }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
