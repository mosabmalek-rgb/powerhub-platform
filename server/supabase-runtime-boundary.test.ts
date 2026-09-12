import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const serverRoot = join(process.cwd(), "server");
const allowedLegacyFiles = new Set([
  "server/admin.ts",
  "server/powerhub.ts",
  "server/db.ts",
]);

const forbiddenPatterns = [
  { label: "drizzle-orm runtime import", pattern: /from [\"']drizzle-orm(?:\/mysql2)?[\"']/ },
  { label: "drizzle schema runtime/type import", pattern: /(?:from|import\()\s*[\"'][^\"']*drizzle\/schema[\"']/ },
  { label: "mysql2 import", pattern: /from [\"']mysql2[\"']/ },
  { label: "DATABASE_URL dependency", pattern: /process\.env\.DATABASE_URL/ },
  { label: "getDb() runtime call", pattern: /\bgetDb\s*\(/ },
  { label: "legacy ./db import", pattern: /from [\"']\.\/db[\"']/ },
];

function collectTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const absolute = join(dir, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) return collectTypeScriptFiles(absolute);
    if (!/\.(?:ts|tsx)$/.test(entry)) return [];
    if (/\.test\.(?:ts|tsx)$/.test(entry)) return [];
    return [absolute];
  });
}

describe("Supabase runtime boundary", () => {
  it("keeps legacy MySQL/Drizzle dependencies inside the explicit migration allowlist", () => {
    const violations: string[] = [];

    for (const file of collectTypeScriptFiles(serverRoot)) {
      const relativePath = relative(process.cwd(), file).replaceAll("\\", "/");
      if (allowedLegacyFiles.has(relativePath)) continue;

      const source = readFileSync(file, "utf8");
      for (const rule of forbiddenPatterns) {
        if (rule.pattern.test(source)) violations.push(`${relativePath}: ${rule.label}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps shared/types.ts independent from the legacy database schema", () => {
    const source = readFileSync(join(process.cwd(), "shared/types.ts"), "utf8");
    expect(source).not.toMatch(/drizzle\/schema/);
    expect(source).not.toMatch(/drizzle-orm/);
    expect(source).not.toMatch(/mysql2/);
  });
});
