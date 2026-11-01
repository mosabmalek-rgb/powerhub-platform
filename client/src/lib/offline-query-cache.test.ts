import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearOfflineHrProjectionCacheForSite,
  isOfflineDashboardQueryKeyForSite,
  isOfflineHrProjectionQueryKeyForSite,
  isOfflineFuelQueryKeyForSite,
  isOfflinePurchaseDetailQueryKeyForSite,
  isOfflineCacheableQueryKey,
  isDeltaSyncBackedQueryKey,
  isOfflineStocktakeAccessQueryKeyForSite,
  isOfflineQueryRecordUsable,
  offlineQueryCacheKey,
  OFFLINE_DASHBOARD_SNAPSHOT_TTL_MS,
  OFFLINE_EXPENSE_FILTER_OPTIONS_TTL_MS,
  OFFLINE_SUPPLIER_FINANCIAL_SNAPSHOT_TTL_MS,
  OFFLINE_HR_DELTA_PROJECTION_TTL_MS,
  OFFLINE_HR_COMPANY_ACCOUNT_OPTIONS_TTL_MS,
  OFFLINE_STOCKTAKE_ACCESS_SNAPSHOT_TTL_MS,
  OFFLINE_STOCKTAKE_LINES_SNAPSHOT_TTL_MS,
  OFFLINE_READING_CYCLE_BOUNDS_TTL_MS,
  getOfflineHrCompanyAccountOptionsExpiry,
  persistOfflineQuery,
  persistOfflineQueryForDeltaSync,
  sanitizeOfflineQueryData,
} from "./offline-query-cache";
import { getOfflineQueryDeltaEntity, getOfflineQueryStaleTime, isOfflineDashboardSnapshotQueryKey, isOfflineDashboardRevisionQueryKey, isSafeSupplierLedgerStatementSnapshot, isSafeSupplierPayablesAgingSnapshot } from "./offline-query-policy";

describe("dashboard cache scope matching", () => {
  it("matches only authorized dashboard snapshot procedures for the exact site", () => {
    const financial = ["powerhub.dashboard.financialKpi", {
      input: { siteId: 7, scope: "branch", metric: "netCash" }, type: "query",
    }];
    const revision = ["powerhub.dashboard.deltaRevision",¶»§q«^