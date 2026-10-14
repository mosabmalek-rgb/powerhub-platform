import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("site billing minimum and fractional settlement contract", () => {
  it("keeps minimum billing policies site-scoped and disabled by default", () => {
    const migration = read("supabase/migrations/20261014130000_powerhub_site_billing_policies.sql");
    expect(migration).toContain("primary key (tenant_id, site_id)");
    expect(migration).toContain("minimum_mode text not null default 'disabled'");
    expect(migration).toContain("minimum_mode in ('disabled','kwh','amount')");
    expect(migration).toContain("powerhub_save_site_billing_policy");
    expect(migration).toContain("FRACTION_RANGES_OVERLAP");
    expect(migration).toContain("revoke execute on function public.powerhub_save_site_billing_policy");
    expect(migration).toContain("grant execute on function public.powerhub_save_site_billing_policy");
  });

  it("applies policy in the central invoice RPC without rewriting factual meter consumption", () => {
    const migration = read("supabase/migrations/20261014130000_powerhub_site_billing_policies.sql");
    expect(migration).toContain("powerhub_issue_invoice_from_reading");
    expect(migration).toContain("v_actual_energy_amount");
    expect(migration).toContain("تسوية الحد الأدنى للاستهلاك");
    expect(migration).toContain("تسوية الحد الأدنى لمبلغ الفاتورة");
    expect(migration).toContain("fraction_digit");
    expect(migration).toContain("for update");
    expect(migration).toContain("deliveryQueued',false");
  });

  it("records carry-forward as an idempotent ledger and includes tenant/site scope", () => {
    const migration = read("supabase/migrations/20261014130000_powerhub_site_billing_policies.sql");
    expect(migration).toContain("create table if not exists public.billing_adjustments");
    expect(migration).toContain("unique (site_id, idempotency_key)");
    expect(migration).toContain("'fraction_carried'");
    expect(migration).toContain("'carried_debt_applied'");
    expect(migration).toContain("applied_to_invoice_id");
    expect(migration).toContain("where id=v_pending.id and state='pending'");
  });

  it("exposes owner-only API and an explicit UI selector for the three minimum modes", () => {
    const server = read("server/powerhub.ts");
    const settings = read("client/src/pages/SettingsPage.tsx");
    expect(server).toContain("siteBillingPolicy: router({");
    expect(server).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"])');
    expect(server).toContain('p_minimum_mode: input.minimumMode');
    expect(settings).toContain("SiteBillingPolicySection");
    expect(settings).toContain('value="kwh">حد أدنى للاستهلاك');
    expect(settings).toContain('value="amount">حد أدنى لمبلغ الفاتورة');
    expect(settings).toContain("نطاق الخصم ونطاق الترحيل متداخلان");
  });
});
