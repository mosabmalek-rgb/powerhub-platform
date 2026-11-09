import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const server = readFileSync("server/powerhub.ts", "utf8");
const review = readFileSync("client/src/pages/PaymentDocumentationReviewPage.tsx", "utf8");
const deposits = readFileSync("client/src/pages/NetworkDirectoryPage.tsx", "utf8");
const accounts = readFileSync("client/src/pages/CompanyAccountsPage.tsx", "utf8");
const cache = readFileSync("client/src/lib/offline-query-cache.ts", "utf8");

describe("financial UX follow-up regression contracts", () => {
  it("filters payment-documentation requests by destination BEFORE the 200 row cap", () => {
    const scope = server.slice(server.indexOf("  paymentDocumentation: router({"), server.indexOf("    // Opaque, revision-only cursor."));
    expect(scope).toContain("recipientAccounts: protectedProcedure.input(siteScoped)");
    expect(scope).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [], "approvePaymentDocumentation")');
    expect(scope).toContain("requirePaymentDocumentationFeature(access.tenantId)");
    expect(scope).toContain('destinationAccountId: z.number().int().positive().optional()');
    expect(scope).toContain('query.eq("destination_account_id", input.destinationAccountId)');
    expect(scope.indexOf('query.eq("destination_account_id", input.destinationAccountId)')).toBeLessThan(scope.indexOf("const { data, error } = await query;"));
    expect(scope).toContain('.eq("tenant_id", access.tenantId)');
    expect(scope).toContain('.eq("site_id", input.siteId)');
    expect(scope).toContain('.limit(200)');
    expect(review).toContain('destinationAccountId:recipientAccountId?Number(recipientAccountId):undefined');
    expect(review).toContain('aria-label="فلتر الحساب المحوّل إليه"');
  });

  it("uses readable table headers on the insurance detail modal", () => {
    expect(deposits).toContain('sticky top-0 bg-[#263a51] text-white');
    expect(deposits).toContain('border-b border-white/20 px-3 py-3 font-bold text-white');
  });

  it("hydrates the identity-checked query cache before best-effort pruning", () => {
    const hydrate = cache.slice(cache.indexOf("export async function hydrateOfflineQueryCache"), cache.indexOf("function capOperationalListRows"));
    expect(hydrate.indexOf('withStore<OfflineQueryRecord[]>(QUERY_STORE, "readonly"')).toBeLessThan(hydrate.indexOf("void pruneOfflineQueryCache(now)"));
    expect(hydrate).toContain("isOfflineQueryRecordUsable(record, userId, now)");
    expect(hydrate).toContain("if (!isStillCurrent()) return hydrated");
  });

  it("exports complete keyset pages without rerunning first-page chart scans", () => {
    expect(accounts).toContain('at: "9999-12-31T23:59:59Z"');
    expect(accounts).toContain("id: Number.MAX_SAFE_INTEGER");
    expect(accounts).toContain("limit: 200");
    expect(accounts).toContain("page.hasNext && (!nextCursor || nextCursor === cursor)");
    expect(accounts).toContain("fetchAllTransactionsForExport(5_000)");
    expect(accounts).toContain("window.open(\"\", \"_blank\")");
    expect(accounts).toContain("popup.print()");
    expect(accounts).toContain("disabled={!selectedAccount || exportingTransactions || !isOnline || !movementRangeReady || !movementDatesValid}");
    expect(accounts).toContain("const exportedIncoming = rowsForExport.reduce");
    expect(accounts).toContain("const exportedOutgoing = rowsForExport.reduce");
    expect(accounts).not.toContain('await downloadReportHtmlAsPdf(root, "حركات-"');
  });
});
