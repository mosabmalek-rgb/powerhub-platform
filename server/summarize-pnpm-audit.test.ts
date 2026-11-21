import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("pnpm audit Markdown report escaping", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("escapes every backslash and pipe and flattens line breaks in dependency paths", () => {
    directory = mkdtempSync(join(tmpdir(), "powerhub-pnpm-audit-"));
    const reportPath = join(directory, "report.json");
    writeFileSync(reportPath, JSON.stringify({
      advisories: {
        "GHSA-test-0000-0000": {
          severity: "high",
          module_name: "fixture",
          findings: [{
            version: "1.0.0",
            paths: ["packages/first\\second|third|fourth\nnext-line"]
          }]
        }
      }
    }));

    const output = execFileSync(
      process.execPath,
      [resolve("scripts/summarize-pnpm-audit.mjs"), reportPath, "1"],
      { encoding: "utf8" }
    );

    expect(output).toContain("packages/first\\\\second\\|third\\|fourth next-line");
  });
});
