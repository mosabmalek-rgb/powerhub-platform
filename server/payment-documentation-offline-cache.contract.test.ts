import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const approvalCache = read("client/src/lib/offline-payment-documentation-approvals.ts");
const approvalPage = read("client/src/pages/PaymentDocumentationReviewPage.tsx");
const queryPolicy = read("client/src/lib/offline-query-policy.ts");
const hrScope = read("docs/hr-scope.md");

describe("payment-documentation offline cache and HR privacy contracts", () => {
  it("isolates approval snapshots by user, branch, exact filters, and freshness", () => {
    expect(approvalCache).toContain("user:${userId}:site:${siteId}:scope:${snapshotScope}:request:${requestId}");
    expect(approvalCache).toContain("row.userId === input.userId && row.siteId === input.siteId");
    expect(approvalCache).toContain("row.snapshotScope === input.snapshotScope");
    expect(approvalCache).toContain("now - row.savedAt <= PAYMENT_DOCUMENTATION_APPROVAL_SNAPSHOT_TTL_MS");
    expect(approvalCache).toContain("dbVersion = 3");
    expect(approvalCache).toContain("if (event.oldVersion < 3 && db.objectStoreNames.contains(storeName))");
  });

  it("uses the same filter signature for save/read and reconciles the cached pending set", () => {
    expect(approvalPage).toContain("paymentDocumentationApprovalSnapshotScope({");
    expect(approvalPage).toContain("listPaymentDocumentationApprovalSnapshots(Number(user.id),siteId,snapshotScope)");
    expect(approvalPage).toContain("savePaymentDocumentationApprovalSnapshots(Number(user.id),siteId,snapshotScope,");
    expect(approvalPage).toContain('status!=="pending"||period==="current_cycle"');
    expect(approvalPage).toContain("if(authorizationDenied||!user?.id||!siteId||status!==\"pending\"||period===\"current_cycle\"");
    expect(approvalCache).toContain("for (const row of existing)");
    expect(approvalCache).toContain("store.delete(row.key)");
    expect(approvalCache).toContain("export async function removePaymentDocumentationApprovalSnapshot(");
    expect(approvalCache).toContain("row.userId === userId && row.siteId === siteId && row.id === requestId");
    expect(approvalCache).toContain("export async function clearPaymentDocumentationApprovalSnapshots(userId: number, siteId: number)");
    expect(approvalCache).toContain("row.userId === userId && row.siteId === siteId) store.delete(row.key)");
    expect(approvalPage).toContain("isExplicitAuthorizationDenial(requests.error)");
    expect(approvalPage).toContain("clearPaymentDocumentationApprovalSnapshots(Number(user.id),siteId)");
    expect(approvalPage).toContain("const visibleRequests:any[] = authorizationDenied ? []");
    expect(approvalPage).toContain("if (authorizationDenied || isOnline || !siteId || !user?.id || !selectedIds.length) return");
  });

  it("does not treat cached review rows as current-cycle truth or as a local financial approval", () => {
    expect(approvalPage).toContain("لا نعرض لقطة «هذه الدورة»");
    expect(approvalPage).toContain("قد تكون قديمة");
    expect(approvalPage).toContain("لا تُنشأ حركة مالية محلياً");
    expect(approvalPage).toContain("لن تُنشأ الحركات المالية حتى تعود الشبكة وتنجح المزامنة والتحقق من الخادم");
    expect(approvalPage).toContain("removePaymentDocumentationApprovalSnapshot(Number(user.id), siteId, requestId)");
    expect(approvalPage).toContain("clearConfirmedOfflineRequest(Number(variables.requestId))");
  });

  it("keeps raw HR queries uncached while allowing only minimized site-scoped projections", () => {
    expect(queryPolicy).toContain('  "hr",');
    expect(queryPolicy).toContain("function isSafeHrOfflineProjection");
    expect(queryPolicy).toContain('"offlineDirectory", "offlineAttendance", "offlineEmployeeAdvances", "offlinePayrollRuns", "offlineCompanyAccountOptions"');
    expect(hrScope).toContain("لا تُخزّن استجابات الموارد البشرية الخام");
    expect(hrScope).toContain("hr_sync_version");
    expect(hrScope).toContain("ليست Delta-backed");
  });
});
