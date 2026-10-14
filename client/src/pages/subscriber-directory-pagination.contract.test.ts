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
});
