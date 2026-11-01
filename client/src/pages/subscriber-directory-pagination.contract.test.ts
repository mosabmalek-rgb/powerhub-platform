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

});
