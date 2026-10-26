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

  it("uses one per-site invoice due interval in hours with legacy-day compatibility and an audit record", () => {
    const migration = read("supabase/migrations/20261018170000_powerhub_invoice_due_interval_hours.sql");
    const server = read("server/powerhub.ts");
    const settings = read("client/src/pages/SettingsPage.tsx");
    const branchPage = read("client/src/pages/BranchesPage.tsx");
    expect(migration).toContain("invoice_due_hours integer");
    expect(migration).toContain("sites_invoice_due_hours_range");
    expect(migration).toContain("powerhub_save_site_invoice_due_hours");
    expect(migration).toContain("site_invoice_due_policy");
    expect(migration).toContain("powerhub_sync_invoice_due_interval");
    expect(migration).toContain("new.invoice_due_days is distinct from old.invoice_due_days");
    expect(migration).toContain("new.invoice_due_hours is distinct from old.invoice_due_hours");
    expect(server).toContain("invoiceDuePolicy: router({");
    expect(server).toContain("p_invoice_due_hours: input.invoiceDueHours");
    expect(server).toContain("const dueHours = Math.max(1, Math.min(2160, Number(access.invoiceDueHours");
    expect(settings).toContain("InvoiceDuePolicySection");
    expect(settings).toContain("وحدة استحقاق الفاتورة");
    expect(branchPage).toContain("مدة الاستحقاق تُدار من الإعدادات");
    expect(branchPage).not.toContain('name="invoiceDueDays"');
  });

  it("validates policy-aware SMS amounts through the shared formatter from the earlier migration", () => {
    const formatterMigration = read("supabase/migrations/20261016110000_powerhub_policy_aware_message_amount_display.sql");
    const migration = read("supabase/migrations/20261019110000_powerhub_policy_aware_sms_amounts.sql");
    expect(formatterMigration).toContain("create or replace function public.powerhub_format_message_amount(");
    expect(migration).toContain("POLICY_AWARE_SMS_AMOUNT_HELPER_VALIDATION_FAILED");
    expect(migration).toContain("position('powerhub_format_message_amount' in v_definition) = 0");
    expect(migration).toContain("trunc(p_amount, 0)");
    expect(migration).toContain("round(p_amount, 1)");
  });

  it("keeps manual collection discounts atomic, auditable, and bounded by remaining debt", () => {
    const migration = read("supabase/migrations/20261014140000_powerhub_manual_collection_discount.sql");
    const server = read("server/powerhub.ts");
    const collectionUi = read("client/src/pages/OperationsPage.tsx");
    expect(migration).toContain("create or replace function public.powerhub_create_payment_with_discount");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("MANUAL_DISCOUNT_EXCEEDS_BALANCE");
    expect(migration).toContain("PAYMENT_AND_DISCOUNT_EXCEED_BALANCE");
    expect(migration).toContain("manual_collection_discount");
    expect(migration).toContain("'manual_collection_discount'");
    expect(migration).toContain("'manual_collection_discount'");
    expect(migration).toContain("cashCollected");
    expect(migration).toContain("powerhub_create_payment(");
    expect(server).toContain("powerhub_create_payment_with_discount");
    expect(server).toContain("manualDiscountAmount");
    expect(collectionUi).toContain("manualDiscountReason");
    expect(collectionUi).toContain("مبلغ التحصيل والخصم معًا يتجاوزان الرصيد المستحق");
  });

  it("rejects sub-cent payment and manual-discount amounts before the financial RPC", () => {
    const server = read("server/powerhub.ts");
    expect(server).toContain("hasAtMostTwoDecimalPlaces");
    expect(server).toContain("amount: z.number().positive().refine(hasAtMostTwoDecimalPlaces");
    expect(server).toContain("manualDiscountAmount: z.number().min(0).max(100000000).refine(hasAtMostTwoDecimalPlaces");
  });

  it("reports only realized automatic and manual discounts by adjustment timestamp", () => {
    const migration = read("supabase/migrations/20261014140000_powerhub_manual_collection_discount.sql");
    const server = read("server/powerhub.ts");
    const dashboard = read("client/src/pages/FinancialDashboardPage.tsx");
    expect(migration).toContain("powerhub_billing_discount_summary");
    expect(migration).toContain("a.state='applied'");
    expect(migration).toContain("a.created_at>=p_from");
    expect(migration).toContain("a.created_at<=p_to");
    expect(migration).toContain("a.adjustment_type in ('auto_fraction_discount','manual_collection_discount')");
    expect(server).toContain("discountSummary: protectedProcedure");
    expect(dashboard).toContain("إحصاءات الخصومات");
    expect(dashboard).toContain("الأرصدة المرحّلة ليست خصومات");
  });

  it("exposes invoice line types and renders applied discounts as deductions in the subscriber PDF", () => {
    const migration = read("supabase/migrations/20261014150000_powerhub_invoice_adjustment_display.sql");
    const pdf = read("client/src/lib/subscriber-portal-pdf.ts");
    const publicInvoice = read("client/src/pages/PublicInvoice.tsx");
    expect(migration).toContain("'lineType', line.line_type");
    expect(migration).toContain("'lineType',line.line_type");
    expect(migration).toContain("revoke all on function public.powerhub_subscriber_portal_invoice");
    expect(migration).toContain("revoke all on function public.powerhub_get_shared_invoice_by_token_hash");
    expect(pdf).toContain('line.lineType === "discount"');
    expect(pdf).toContain("-Math.abs(Number(line.amount))");
    expect(publicInvoice).toContain('line.lineType === "discount"');
    expect(publicInvoice).toContain("Math.round(Math.abs(amount) * 100) > 0");
    expect(publicInvoice).toContain("const isFractionalCarry");
    expect(publicInvoice).toContain("تسوية الكسر المرحّل");
    expect(publicInvoice).toContain("minimumFractionDigits: 2");
  });

  it("types public invoice line categories for discount rendering", () => {
    const source = read("server/powerhub.ts");
    expect(source).toContain("lineType?: string; description: string; amount: number");
  });

  it("reconciles the carried fraction as a negative invoice line without counting it as a discount", () => {
    const source = read("supabase/migrations/20261014130000_powerhub_site_billing_policies.sql");
    expect(source).toContain("'other','كسر مُرحّل إلى الفاتورة التالية',1,-v_fraction_to_carry,-v_fraction_to_carry,8");
    expect(source).toContain("'fraction_carried',v_fraction_to_carry,'pending'");
    expect(source).toContain("v_total_amount := round(greatest(0,v_raw_total-v_auto_fraction_discount-v_fraction_to_carry)+v_previous_carry,2)");
  });

  it("rejects cross-tenant/site invoice idempotency replays", () => {
    const source = read("supabase/migrations/20261014130000_powerhub_site_billing_policies.sql");
    expect(source).toContain("INVOICE_OPERATION_SCOPE_CONFLICT");
    expect(source).toContain("operation_type='invoice_issue'");
    expect(source).toContain("entity_type='invoice'");
  });

  it("validates payment replay against the original payment scope", () => {
    const source = read("supabase/migrations/20261014140000_powerhub_manual_collection_discount.sql");
    expect(source).toContain("PAYMENT_OPERATION_SCOPE_CONFLICT");
    expect(source).toContain("p.subscriber_id=p_subscriber_id and p.invoice_id is not distinct from p_invoice_id");
  });

  it("applies the minimum amount floor after the ordinary invoice discount", () => {
    const source = read("supabase/migrations/20261014130000_powerhub_site_billing_policies.sql");
    expect(source).toContain("v_raw_total := greatest(0,round(v_energy_amount+v_tariff.fixed_fee+v_tax_amount-p_discount_amount,2))");
    expect(source).toContain("v_minimum_amount_adjustment := round(coalesce(v_policy.minimum_invoice_amount,0)-v_raw_total,2)");
    expect(source).toContain("raise exception 'INVALID_DISCOUNT'");
  });

  it("does not queue an offline payment if a manual discount would be lost", () => {
    const source = read("client/src/pages/OperationsPage.tsx");
    expect(source).toContain("تعذر تأكيد التحصيل مع الخصم اليدوي دون اتصال");
    expect(source).toContain("Number(completePayload.manualDiscountAmount ?? 0) > 0");
  });
});
