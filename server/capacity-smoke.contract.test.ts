import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "scripts/powerhub-capacity-smoke.mjs"), "utf8");

describe("capacity smoke safety contract", () => {
  it("rejects production targets unless explicitly overridden", () => {
    expect(source).toContain("ALLOW_PRODUCTION_LOAD === \"1\"");
    expect(source).toContain("رفض اختبار الحمل على Production");
  });

  it("reports bounded concurrency and latency percentiles", () => {
    expect(source).toContain("LOAD_CONCURRENCY");
    expect(source).toContain("p50");
    expect(source).toContain("p95");
    expect(source).toContain("p99");
  });
});
