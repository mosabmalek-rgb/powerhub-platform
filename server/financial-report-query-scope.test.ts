import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
const supabase = read("server/powerhub-supabase.ts");
const router = read("server/powerhub.ts");
const reportReads = supabase.slice(
  supabase.indexOf("export async function listSupabaseReportInvoices"),
  supabase.indexOf("export async function getSupabaseFinancialOverview"),
);
const reportRoutes = router.slice(router.indexOf("  reports: router({"), router.indexOf("  reportBranding: router({"));

describe("date-scoped financial report queries", () => {
  it("scopes report invoices by tenant, selected sites, and requested period in PostgreSQL", () => {
    expect(reportReads).toContain('.eq("tenant_id", input.tenantId)');
    expect(reportReads).toContain('.in("site_id", siteIds)');
    expect(reportReads).toContain('.gte("issue_date", input.start!.toISOString())');
    expect(reportReads).toContain('.lt("issue_date", input.endExclusive!.toISOString())');
    expect(reportReads).toContain('.eq("billing_period", input.billingPeriod)');
  });

  it("scopes payments and expenses by tenant, sites, and half-open date ranges", () => {
    expect(reportReads).toContain('.gte("paid_at", input.start.toISOString())');
    expect(reportReads).toContain('.lt("paid_at", input.endExclusive.toISOString())');
    expect(reportReads).toContain('.gte("occurred_at", input.start.toISOString())');
    expect(reportReads).toContain('.lt("occurred_at", input.endExclusive.toISOString())');
  });

  it("keeps report reads paged and does not request receipt image keys or URLs", () => {
    expect(reportReads).toContain("readSupabaseReportPages");
    expect(reportReads).toContain("const pageSize = 500");
    expect(reportReads).not.toContain("receipt_image_key");
    expect(reportReads).not.toContain("storageGet(");
  });

  it("routes range, monthly, and all-branch reports through scoped reads instead of full-history lists", () => {
    expect(reportRoutes).toContain("listSupabaseReportInvoices");
    expect(reportRoutes).toContain("listSupabaseReportPayments");
    expect(reportRoutes).toContain("listSupabaseReportExpenses");
    expect(reportRoutes).not.toContain("listSupabaseInvoices(input.siteId)");
    expect(reportRoutes).not.toContain("listSupabasePayments(input.siteId)");
    expect(reportRoutes).not.toContain("listSupabaseExpenses(input.siteId)");
  });

  it("loads only subscribers referenced by report invoices and keeps tenant/site scope", () => {
    expect(reportReads).toContain('.eq("tenant_id", input.tenantId)');
    expect(reportReads).toContain('.in("site_id", siteIds)');
    expect(reportReads).toContain('.in("id", ids)');
    expect(reportRoutes).toContain("subscriberIds: invoiceRows.map((invoice) => invoice.subscriberId)");
  });
});
