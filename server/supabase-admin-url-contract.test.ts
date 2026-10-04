import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const admin = readFileSync(resolve(process.cwd(), "server/supabase-admin.ts"), "utf8");

describe("Supabase server project URL contract", () => {
  it("prefers the verified VITE Supabase URL over a potentially stale server URL", () => {
    expect(admin).toContain("process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL");
    expect(admin).not.toContain("process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL");
  });
});
