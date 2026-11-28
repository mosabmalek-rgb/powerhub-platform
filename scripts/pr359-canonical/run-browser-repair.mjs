
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

assert.equal(process.env.GITHUB_ACTIONS, "true", "disposable CI only");
assert.equal(process.argv.length, 2, "no external target accepted");
const chrome = ["google-chrome", "chromium", "chromium-browser"].find(name =>
  spawnSync("which", [name], { stdio: "ignore" }).status === 0);
assert.ok(chrome, "Chrome/Chromium unavailable");
const bundle = await build({ entryPoints: ["scripts/pr359-canonical/browser-repair-fixture.ts"], bundle: true,
  platform: "browser", format: "esm", target: "chrome120", write: false });
assert.equal(bundle.outputFiles.length, 1);
const profile = await mkdtemp(join(tmpdir(), "pr359-browser-"));
let child, timeout;
let settle, fail;
const result = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
const server = createServer(async (req, res) => {
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'self'");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" && (req.url === "/" || req.url === "/peer" || req.url === "/top-peer")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end('<!doctype html><title>PR359 isolated repair fixture</title><script type="module" src="/fixture.js"></script>');
  }
  if (req.method === "GET" && req.url === "/fixture.js") {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    return res.end(bundle.outputFiles[0].text);
  }
  if (req.method === "POST" && req.url === "/result") {
    try {
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 16384) throw Error("oversized result"); }
      const value = JSON.parse(body);
      res.end("ok"); settle(value);
    } catch (error) { res.statusCode = 400; res.end(); fail(error); }
    return;
  }
  res.statusCode = 404; res.end();
});
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  child = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking",
    "--disable-component-update",  "--disable-popup-blocking", "--no-first-run", "--no-default-browser-check", "--user-data-dir=" + profile, origin],
    { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-8000); });
  child.once("error", fail);
  child.once("exit", (code, signal) => fail(new Error("Chrome exited: " + code + "/" + signal + "\n" + stderr)));
  timeout = setTimeout(() => fail(new Error("Native IndexedDB fixture timed out\n" + stderr)), 90000);
  const outcome = await result;
  assert.equal(outcome.ok, true, outcome.error);
  const required = ["PR359_NATIVE_IDB_ATOMIC_ABORT_PASS", "PR359_NATIVE_IDB_RELOAD_REPAIR_PASS", "PR359_NATIVE_IDB_OUTBOX_ISOLATION_PASS", "PR359_NATIVE_WEB_LOCK_CROSS_CONTEXT_PASS", "PR359_NATIVE_OBSOLETE_RUN_REJECTED_PASS", "PR359_NATIVE_CACHE_FAILURE_RETRY_PASS", "PR359_NATIVE_REAL_QUERY_CACHE_ABORT_RETRY_RELOAD_PASS", "PR359_NATIVE_HYDRATION_LIVE_AND_IDENTITY_RACE_PASS", "PR359_NATIVE_TOP_LEVEL_WINDOW_LOCK_PASS", "PR359_NATIVE_PRUNE_REFRESH_RACE_PASS", "PR359_NATIVE_CACHE_AHEAD_CHECKPOINT_ABORT_REPLAY_PASS", "PR359_NATIVE_RETENTION_REPAIR_VERSION_PASS"];
  assert.deepEqual(outcome.markers, required);
  for (const marker of required) console.log(marker);
  console.log("PR359_NATIVE_IDB_FIXTURE_ONLY_NO_HOSTED_AUTHORIZATION");
} finally {
  clearTimeout(timeout);
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, "exit").catch(() => undefined);
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await stopped;
    clearTimeout(killTimer);
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  // Chromium helpers can still release profile files after the browser exits.
  // Retry only the filesystem errors supported by fs.rm; persistent cleanup errors still fail CI.
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
