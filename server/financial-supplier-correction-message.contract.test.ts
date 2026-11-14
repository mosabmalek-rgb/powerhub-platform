import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const router = readFileSync("server/powerhub-inventory-router.ts","utf8");
const guard = readFileSync(
  "supabase/migrations/20261112180000_powerhub_financial_b4141_supplier_reversal_replay_guard.sql","utf8"
);

describe("B4 posted supplier payment correction remains fail-closed",()=>{
  it("reports the protected financial conflict rather than a false reversal success",()=>{
    expect(router).toContain("SUPPLIER_PAYMENT_POSTED_GL_SOURCE_REVERSAL_REQUIRED:");
    expect(router).toContain('code: "CONFLICT"');
    expect(router).toContain("لم تُنفّذ أي حركة عكس");
    expect(router).toContain('rpc("powerhub_inventory_reverse_supplier_payment_flexible"');
    expect(router).toContain('if (error || !data?.[0]) mapPurchaseDatabaseError(error, "تعذر عكس دفعة المورد.")');
  });
  it("blocks previously posted GL in both reversal paths, including already-reversed replay",()=>{
    expect(guard).toContain("SUPPLIER_PAYMENT_POSTED_GL_SOURCE_REVERSAL_REQUIRED");
    expect(guard.match(/SUPPLIER_PAYMENT_POSTED_GL_SOURCE_REVERSAL_REQUIRED/g)?.length).toBe(2);
    const occurrences=[...guard.matchAll(/IF EXISTS \(/g)];
    expect(occurrences.length).toBeGreaterThan(0);
    const replay=guard.indexOf("if v_payment.status='reversed' then");
    expect(replay).toBeGreaterThan(0);
    expect(guard.slice(0,replay)).toContain("SUPPLIER_PAYMENT_POSTED_GL_SOURCE_REVERSAL_REQUIRED");
  });
});
