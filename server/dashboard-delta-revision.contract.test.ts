import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const router = readFileSync(resolve(process.cwd(), "server/powerhub.ts"), "utf8");

describe("dashboard Delta revision contract", () => {
  it("exposes only a scoped change fingerprint and no operational rows", () => {
    const start = router.indexOf("deltaRevision: protectedProcedure");
    const end = router.indexOf("financialOverview: protectedProcedure", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const procedure = router.slice(start, end);

    expect(procedure).toContain("requireSupabaseSiteRole");
    expect(procedure).toContain("requireSupabaseAllBranchesRole");
    expect(procedure).toContain('.eq("tenant_id", access.tenantId)');
    expect(procedure).toContain('.in("entity_type", entityTypes)');
    expect(procedure).toContain('query = query.eq("site_id", input.siteId)');
    expect(procedure).toContain("last_cursor");
    expect(procedure).toContain("revision, observedAt");
    expect(procedure).not.toContain(".select(\"*\")");
    expect(procedure).not.toContain("row_data");
  });

  it("tracks only the explicit journaled entities that can affect dashboard aggregates", () => {
    const start = router.indexOf("deltaRevision: protectedProcedure");
    const end = router.indexOf("financialOverview: protectedProcedure", start);
    const procedure = router.slice(start, end);
    for (const entity of [
      "sites", "subscribers", "generators", "readings", "tariffs",
      "invoices", "payments", "expenses", "company_accounts", "company_accounts_all",
    ]) expect(procedure).toContain(`"${entity}"`);
  });
});
