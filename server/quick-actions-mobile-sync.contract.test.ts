import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeltaSyncBackedQueryKey, isOfflineCacheableQueryKey } from "../client/src/lib/offline-query-policy";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Quick Actions and field-sync offline contract", () => {
  it("keeps privileged Quick Actions hidden without a usable permission snapshot and suppresses it on server denial", () => {
    const page = read("client/src/pages/QuickActionsPage.tsx");
    expect(page).toContain("isExplicitAuthorizationDenial");
    expect(page).toContain("const showOfflineRecovery = !isOnline && !isChecking && !authorizationDenied && !hasUsableSnapshot");
    expect(page).toContain('setLocation("/offline-sync")');
    expect(page).toContain('setLocation("/workspace")');
    expect(page).toContain("authorizationDenied ?");
    expect(page).toContain("|| !isOnline");
  });
  it("does not persist permission snapshots or server-side field monitoring feeds as generic offline data", () => {
    const keys = [
      ["powerhub.quickActions.preferences", { input: { siteId: 7 }, type: "query" }],
      ["powerhub.staff.myAccess", { input: { siteId: 7 }, type: "query" }],
      ["powerhub.mobileSync.summary", { input: { siteId: 7 }, type: "query" }],
      ["powerhub.mobileSync.technicians", { input: { siteId: 7 }, type: "query" }],
      ["powerhub.mobileSync.list", { input: { siteId: 7, page: 1, pageSize: 25 }, type: "query" }],
      ["powerhub.mobileSync.readings", { input: { siteId: 7, page: 1, pageSize: 20 }, type: "query" }],
    ] as const;
    for (const key of keys) {
      expect(isOfflineCacheableQueryKey(key)).toBe(false);
      expect(isDeltaSyncBackedQueryKey(key)).toBe(false);
    }
  });
  it("pauses server monitoring while offline and renders unknown values instead of false zeroes", () => {
    const page = read("client/src/pages/MobileSyncPage.tsx");
    expect(page).toContain("const serverQueriesEnabled = Boolean(isAuthenticated && siteId && isOnline && !isChecking)");
    expect(page).toContain("const summaryData = summaryDenied ? undefined : summary.data");
    expect(page).toContain("const eventsData = eventsDenied ? undefined : events.data");
    expect(page).toContain("const readingsData = readingsDenied ? undefined : readings.data");
    expect(page).toContain('value === null ? "—" : value.toLocaleString("ar-IQ")');
    expect(page).toContain("اعتماد القراءات وإصدار الفواتير يتطلب اتصالاً بالخادم");
    expect(page).toContain('href="/offline-sync"');
    expect(page).toContain("لا توجد لقطة جلسة");
  });
  it("does not label a missing branch list as an empty workspace or clear Outbox after denial", () => {
    const page = read("client/src/pages/OfflineSyncPage.tsx");
    expect(page).toContain("siteAccessDenied");
    expect(page).toContain("لم نحذف أي عملية من Outbox");
    expect(page).toContain("الانقطاع لا يعني عدم وجود فرع");
    expect(page).toContain("refetchOnReconnect: true");
  });
});
