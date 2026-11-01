import type { Query, QueryClient } from "@tanstack/react-query";
import superjson from "superjson";
import { isOfflineCacheableQueryKey, isDeltaSyncBackedQueryKey, isOfflineDashboardSnapshotQueryKey, isOfflineDashboardRevisionQueryKey, isSafeFilteredOperationalSnapshot, isSafePurchaseDetailSnapshot, isSafeSupplierLedgerStatementSnapshot, isSafeSupplierPayablesAgingSnapshot } from "./offline-query-policy";
import { clearOperationalReportSnapshotsForUser } from "./offline-operational-report-cache";
export { isOfflineCacheableQueryKey, isDeltaSyncBackedQueryKey } from "./offline-query-policy";

const DATABASE_NAME = "powerhub-offline-cache";
const DATABASE_VERSION = 2;
const QUERY_STORE = "queries";
const AUTH_STORE = "auth-users";
export const OFFLINE_QUERY_CACHE_MAX_RECORDS_PER_USER = 200;
export const OFFLINE_QUERY_CACHE_MAX_RECORD_BYTES = 2 * 1024 * 1024;
export const OFFLINE_DASHBOARD_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
export const OFFLINE_EXPENSE_FILTER_OPTIONS_TTL_MS = 24 * 60 * 60 * 1000;
export const OFFLINE_SUPPLIER_FINANCIAL_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
export const OFFLINE_HR_DELTA_PROJECTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OFFLINE_HR_COMPANY_ACCOUNT_OPTIONS_TTL_MS = 24 * 60 * 60 * 1000;
// Minimal stocktake capability hints support offline drafts only; server RPCs re-authorize.
export const OFFLINE_STOCKTAKE_ACCESS_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
// Cycle boundaries are date-filter metadata, not financial authority; expire them da¶»§q«^