import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("subscriber account statement complete-history contract", () => {
  it("loads each statement section independently with a bounded cursor page", () => {
    const page = read("client/src/pages/SubscriberAccountStatementPage.tsx");
    for (const section of ["invoices", "payments", "readings"]) {
      expect(page).toContain(`section:"${section}",cursor:`);
    }
    expect(page.match(/accountStatementHistoryPage\.useQuery/g)).toHaveLength(3);
    expect(page).toContain("limit:20");
    expect(page).toContain("mergeById");
    expect(page).toContain("setInvoiceCursor(invoicePage.data.nextCursor??undefined)");
    expect(page).toContain("setPaymentCursor(paymentPage.data.nextCursor??undefined)");
    expect(page).toContain("setReadingCursor(readingPage.data.nextCursor??undefined)");
  });

  it("does not export a partial or count-inconsistent statement", () => {
    const page = read("client/src/pages/SubscriberAccountStatementPage.tsx");
    expect(page).toContain("historyCountsMatch");
    expect(page).toContain("allInvoices.length===Number(data.summary.invoiceCount)");
    expect(page).toContain("allPayments.length===Number(data.summary.paymentCount)");
    expect(page).toContain("allReadings.length===Number(data.summary.readingCount)");
    expect(page).toContain("!historyComplete||!pdfRef.current||!pdfData");
    expect(page).toContain("!historyComplete||!pdfData");
    expect(page).toContain("disabled={!statementIsAuthoritative||!historyComplete}");
    expect(page).toContain("<Printable data={pdfData} branding={branding.data}/>");
    expect(page).not.toContain("آخر 20 فاتورة");
    expect(page).not.toContain("آخر 20 دفعة");
    expect(page).not.toContain("آخر 20 قراءة");
  });

  it("uses stable tenant/site-scoped keyset pagination and explicit item types on the server", () => {
    const source = read("server/powerhub-supabase.ts");
    const start = source.indexOf("export async function listSupabaseSubscriberAccountStatementHistoryPage");
    const end = source.indexOf("export async function listSupabaseTariffs", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const implementation = source.slice(start, end);
    expect(implementation).toContain("Promise<SupabaseHistoryPage<SubscriberStatementHistoryItem>>");
    expect(implementation).not.toContain("SupabaseHistoryPage<any>");
    expect(implementation).toContain('.eq("tenant_id", tenantId).eq("site_id", siteId).eq("subscriber_id", subscriberId)');
    expect(implementation).toContain('.eq("tenant_id", tenantId).eq("site_id", siteId).in("id", invoiceIds)');
    expect(implementation).toContain('.eq("tenant_id", tenantId).eq("site_id", siteId).eq("subscriber_id", subscriberId).eq("status", "completed")');
    expect(implementation).toContain('.order("issue_date", { ascending: false }).order("id", { ascending: false }).limit(limit + 1)');
    expect(implementation).toContain('.order("paid_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1)');
    expect(implementation).toContain('.order("reading_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1)');
    expect(implementation).toContain("id.lt.");
  });

  it("rejects malformed/non-canonical cursors and keeps the protected router permission gate", () => {
    const source = read("server/powerhub-supabase.ts");
    const router = read("server/powerhub.ts");
    expect(source).toContain("if (normalizedAt !== parsed.at) throw new Error");
    expect(source).toContain('code: "BAD_REQUEST", message: "مؤشر الصفحة غير صالح');
    const start = router.indexOf("accountStatementHistoryPage: protectedProcedure");
    const end = router.indexOf("quota: protectedProcedure", start);
    expect(start).toBeGreaterThanOrEqual(0);
    const procedure = router.slice(start, end);
    expect(procedure).toContain("z.enum([\"invoices\", \"payments\", \"readings\"])");
    expect(procedure).toContain("z.number().int().min(1).max(100).default(20)");
    expect(procedure).toContain("requireSupabaseSiteRole(ctx.user.id, input.siteId");
  });
});
