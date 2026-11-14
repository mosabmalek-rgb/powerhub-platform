import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("scheduled image retention endpoint", () => {
  it("keeps the cron secret and POST gate while allowing explicit dry-run inspection", () => {
    const source = readFileSync(resolve(process.cwd(), "server/_core/index.ts"), "utf8");
    const start = source.indexOf('app.all("/api/scheduled/payment-documentation-retention"');
    const end = source.indexOf('app.all("/api/scheduled/*"', start);
    const route = source.slice(start, end);
    expect(route).toContain('const authorization = req.headers.authorization ?? "";');
    expect(route).toContain('if (!configuredSecret || authorization !== `Bearer ${configuredSecret}`)');
    expect(route).toContain('if (req.method !== "POST")');
    expect(route).toContain('(req.body as { dryRun?: unknown }).dryRun === true');
    expect(route).toContain('requestedDryRun ? { dryRun: true } : {}');
    expect(route).not.toContain("dryRun: false");
  });
});
