import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("subscriber directory pagination and type support", () => {
  it("caps the subscriber directory at 20 rows per page and resets paging when filters change", () => {
    const page = read("client/src/pages/NetworkDirectoryPage.tsx");
    expect(page).toContain("const SUBSCRIBER_PAGE_SIZE = 20");
    expect(page).toContain("page: subscriberPage, pageSize: SUBSCRIBER_PAGE_SIZE");
    expect(page).toContain("subscribersQuery.data?.items ?? []");
    expect(page).toContain('refetchOnReconnect: "always"');
    expect(page).toContain("staleTime: 60 * 60 * 1000");
    expect(page).toContain('aria-label="فلتر نوع المشترك"');
    expect(page).toContain('value="institution">مؤسسات</option>');
    expect(page).toContain('value="mosque">مساجد</option>');
    expect(page).toContain('setSubscriberPage(1)');
  });

  it("uses all open invoice rows for the arrears workspace and no longer repeats the priority-debtors table", () => {
    const page = read("client/src/pages/NetworkDirectoryPage.tsx");
    const utilities = read("server/financial-overview-utils.ts");
    expect(page).toContain("overview?.outstandingInvoices ?? []");
    expect(page).not.toContain("المشتركون ذوو أولوية التحصيل");
    expect(utilities).toContain("outstandingInvoices: outstandingInvoices.sort");
  });

  it("preserves the real subscriber creation and import path for the two new categories", () => {
    const server = read("server/powerhub.ts");
    const importer = read("client/src/lib/subscriber-import.ts");
    const bulkUi = read("client/src/components/BulkSubscriberImport.tsx");
    expect(server).toContain('z.enum(["residential", "commercial", "institution", "mosque"])');
    expect(importer).toContain('return "institution"');
    expect(importer).toContain('return "mosque"');
    expect(bulkUi).toContain("subscriptionType: row.normalizedSubscriptionType ?? \"residential\"");
  });

  it("safely extends the database constraint and patches both database validation paths", () => {
    const migration = read("supabase/migrations/20261014170000_powerhub_subscriber_type_institution_mosque.sql");
    expect(migration).toContain("'residential', 'commercial', 'institution', 'mosque'");
    expect(migration).toContain("SUBSCRIBER_BULK_TYPE_VALIDATION_PATTERN_NOT_FOUND");
    expect(migration).toContain("SUBSCRIBER_OPENING_READING_TYPE_VALIDATION_PATTERN_NOT_FOUND");
    expect(migration).toContain("pg_get_functiondef(p.oid)");
  });
  it("uses readable 14px record tables and keeps long arrears names within their column", () => {
    const page = read("client/src/pages/NetworkDirectoryPage.tsx");
    const styles = read("client/src/index.css");
    expect(styles).toContain("font-size: 14px !important;");
    expect(page).toContain(': "مستحق";');
    expect(page).not.toContain('"مستحق لاحقاً";');
    expect(page).toContain("[overflow-wrap:anywhere]");
    expect(page).toContain('["10%", "20%", "9%", "9%", "10%", "11%", "10%", "11%", "10%"]');
    expect(page).toContain('["20%", "10%", "10%", "12%", "13%", "13%", "12%", "10%"]');
  });


  it("shows approved outstanding security deposits in an 80% scrollable dialog with 11px rows", () => {
    const page = read("client/src/pages/NetworkDirectoryPage.tsx");
    const overview = page.slice(
      page.indexOf("function SubscriberSecurityDepositOverview("),
      page.indexOf("\nfunction SubscriberFinancialOverview("),
    );
    expect(overview).toContain("h-[80vh]");
    expect(overview).toContain("w-[80vw]");
    expect(overview).toContain("grid-rows-[auto_minmax(0,1fr)_auto]");
    expect(overview).toContain("overflow-auto");
    expect(overview).toContain("text-[11px]");
    expect(overview).toContain("المبلغ المعتمد للتأمين");
    expect(overview).toContain("إجمالي مبلغ التأمينات القائمة");
    expect(overview).toContain("عدد المشتركين الذين لديهم مبلغ تأمين");
  });

  it("exports security deposits as a real selectable/searchable HTML table, never a screenshot", () => {
    const page = read("client/src/pages/NetworkDirectoryPage.tsx");
    const overview = page.slice(
      page.indexOf("function SubscriberSecurityDepositOverview("),
      page.indexOf("\nfunction SubscriberFinancialOverview("),
    );
    expect(overview).toContain("workbook.addWorksheet(\"تأمينات المشتركين\"");
    expect(overview).toContain("المبلغ المعتمد للتأمين");
    expect(overview).toContain("window.open(\"\", \"_blank\")");
    expect(overview).toContain("popup.document.write");
    expect(overview).toContain("<table>");
    expect(overview).toContain("<thead>");
    expect(overview).toContain("<tbody>");
    expect(overview).toContain("popup.print()");
    expect(overview).not.toContain("html2canvas");
    expect(overview).not.toContain("canvas.toDataURL");
    expect(overview).not.toContain("downloadReportHtmlAsPdf");
  });

  it("uses one offline subscriber payload for both opening-reading and reserved-number creation paths", () => {
    const page = read("client/src/pages/NetworkDirectoryPage.tsx");
    const submit = page.slice(page.indexOf("const submitSubscriber = async"), page.indexOf("const submitGenerator = async"));
    expect(submit).toContain("const offlineSubscriberPayload:");
    expect(submit).toContain("payload: offlineSubscriberPayload");
    expect(submit.match(/payload: offlineSubscriberPayload/g)).toHaveLength(2);
    expect(submit).toContain("securityDepositAmount: base.securityDepositAmount");
    expect(submit).toContain("securityDepositOperationId: base.securityDepositOperationId");
    expect(submit).toContain("securityDepositPaymentNo: base.securityDepositPaymentNo");
    expect(submit).toContain("enqueueOfflineSubscriberCreateWithNumber");
    expect(submit).toContain("enqueueOfflineWork");
  });

  it("replays an offline subscriber and its security deposit through the same idempotent server operation", () => {
    const panel = read("client/src/components/OfflineWorkSyncPanel.tsx");
    const refresh = read("client/src/lib/offline-sync-refresh.ts");
    expect(panel).toContain("createSubscriber.mutateAsync({ siteId: item.siteId, ...payload, clientOperationId: item.clientOperationId })");
    expect(refresh).toContain('subscriber_create: ["subscribers", "subscriber-quota", "dashboard-summary"]');
    expect(refresh).toContain('"securityDepositAmount" in result.item.payload');
    expect(refresh).toContain('targets.add("security-deposits")');
    const server = read("server/powerhub.ts");
    expect(server).toContain('securityDepositOperationId: z.string().uuid().optional()');
    expect(server).toContain('admin.rpc("powerhub_create_subscriber_with_security_deposit"');
  });

});
