// Pure query-key policy shared by cache hydration and the TanStack Query client.

// Keeping this module free of IndexedDB/superjson imports avoids pulling storage into the startup bundle.

const CACHEABLE_PROCEDURES = new Set([
  "sites",
  "subscribers",
  "generators",
  "readings",
  "tariffs",
  "schedules",
  "companyAccounts",
]);

// Only these list procedures currently have a corresponding Delta reconciliation
// path. Other cached lists retain their original age and must refetch normally.
const DELTA_SYNC_PROCEDURES = new Set(["sites", "subscribers", "generators", "readings", "tariffs", "companyAccounts"]);

const BLOCKED_PROCEDURES = new Set([
  "admin",
  "auth",
  "messaging",
  "audit",
  "payments",
  "collections",
  "finance",
  "financialDashboard",
  "financialSettlements",
  "expenses",
  "payroll",
  "attendance",
]);

function getPowerHubQuerySegments(queryKey: readonly unknown[]) {
  const first = queryKey[0];
  if (Array.isArray(first)) return first.filter((part): part is string => typeof part === "string");
  if (typeof first === "string" && first.includes(".")) return first.split(".");
  if (typeof first === "string") return queryKey.slice(0, 3).filter((part): part is string => typeof part === "string");
  return [];
}

const SUBSCRIBER_DIRECTORY_PAGE_SIZE = 20;
const MAX_CACHEABLE_SUBSCRIBER_DIRECTORY_PAGE = 200;
const SUBSCRIBER_DIRECTORY_INPUT_KEYS = new Set([
  "siteId",
  "page",
  "pageSize",
  "search",
  "subscriptionType",
]);

function getOfflineQueryInput(queryKey: readonly unknown[]): Record<string, unknown> | null {
  const options = queryKey[1];
  if (!options || typeof options !== "object" || Array.isArray(options)) return null;
  const wrapper = options as Record<string, unknown>;
  const input = Object.prototype.hasOwnProperty.call(wrapper, "input") ? wrapper.input : wrapper;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function isSafeUnfilteredSubscriberDirectoryPage(queryKey: readonly unknown[]) {
  const input = getOfflineQueryInput(queryKey);
  if (!input || Object.keys(input).some((key) => !SUBSCRIBER_DIRECTORY_INPUT_KEYS.has(key))) return false;
  return Number.isSafeInteger(input.siteId) && Number(input.siteId) > 0 &&
    Number.isSafeInteger(input.page) && Number(input.page) >= 1 &&
    Number(input.page) <= MAX_CACHEABLE_SUBSCRIBER_DIRECTORY_PAGE &&
    input.pageSize === SUBSCRIBER_DIRECTORY_PAGE_SIZE &&
    input.search === "" &&
    input.subscriptionType === undefined;
}

const OFFLINE_PAGE_READ_INPUT_KEYS: Record<string, ReadonlySet<string>> = {
  "readings.page": new Set(["siteId", "limit", "cursor"]),
  "invoices.page": new Set(["siteId", "limit", "cursor"]),
  "payments.page": new Set(["siteId", "limit", "cursor"]),
  "expenses.page": new Set(["siteId", "limit", "startDate", "endDate", "companyAccountId"]),
};

function isValidOfflineDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Cache only bounded, site-scoped page snapshots whose inputs are explicitly
 * known. These pages are display snapshots, not offline financial authority;
 * until their server change-feed adapters exist, they remain cache-only and refresh from their exact page key on reconnect.
 */
function isSafeScopedOfflinePage(queryKey: readonly unknown[], segments: string[]) {
  if (segments.length !== 3 || segments[2] !== "page") return false;
  const procedure = `${segments[1]}.${segments[2]}`;
  const allowedKeys = OFFLINE_PAGE_READ_INPUT_KEYS[procedure];
  if (!allowedKeys) return false;

  const input = getOfflineQueryInput(queryKey);
  if (!input || Object.keys(input).some((key) => !allowedKeys.has(key))) return false;
  if (!Number.isSafeInteger(input.siteId) || Number(input.siteId) < 1) return false;
  if (input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 200)) return false;

  if ((procedure === "readings.page" || procedure === "invoices.page" || procedure === "payments.page") &&
      input.cursor !== undefined &&
      (typeof input.cursor !== "string" || input.cursor.length === 0 || input.cursor.length > 500)) return false;

  if (procedure === "expenses.page") {
    const hasStart = input.startDate !== undefined;
    const hasEnd = input.endDate !== undefined;
    if (hasStart !== hasEnd) return false;
    if (hasStart && (!isValidOfflineDate(input.startDate) || !isValidOfflineDate(input.endDate) ||
        String(input.startDate) > String(input.endDate))) return false;
    if (input.companyAccountId !== undefined &&
        (!Number.isSafeInteger(input.companyAccountId) || Number(input.companyAccountId) < 1)) return false;
  }
  return true;
}

export function isOfflineCacheableQueryKey(queryKey: readonly unknown[]) {
  const segments = getPowerHubQuerySegments(queryKey);
  if (segments[0] !== "powerhub") return false;
  // Explicit site-scoped page allowlist is evaluated before BLOCKED_PROCEDURES:
  // only the named read pages above may persist, never their list/mutation/summaries.
  if (isSafeScopedOfflinePage(queryKey, segments)) return true;
  if (segments.some((value) => BLOCKED_PROCEDURES.has(value))) return false;

  // Cache only the unfiltered, fixed-size subscriber directory pages. Search
  // results and type-filtered pages may contain a user's ad-hoc selections and
  // are intentionally not persisted. The input contract also bounds page size
  // and rejects extra query fields so unrelated procedures cannot opt in.
  if (segments[1] === "subscribers" && segments[2] === "directoryPage") {
    return isSafeUnfilteredSubscriberDirectoryPage(queryKey);
  }

  // Only stable whole-list query shapes are persisted. Search pages, details,
  // summaries, mutations and other methods under an otherwise cacheable router
  // must opt in explicitly rather than inheriting permission from the router name.
  if (segments.length < 3 || segments[2] !== "list") return false;
  return CACHEABLE_PROCEDURES.has(segments[1] ?? "");
}

export function isDeltaSyncBackedQueryKey(queryKey: readonly unknown[]) {
  const segments = getPowerHubQuerySegments(queryKey);
  if (!isOfflineCacheableQueryKey(queryKey) || segments.length < 3 || segments[0] !== "powerhub") return false;

  // Reading and invoice history are materialized from their full scoped Delta
  // snapshots into the exact keyset page shape expected by the UI.
  if ((segments[1] === "readings" || segments[1] === "invoices" || segments[1] === "payments" || segments[1] === "expenses") && segments[2] === "page") {
    // Expense filters do not match the full branch Delta feed. Keep cached snapshots,
    // but do not claim Delta reconciliation until a filter-aware materializer exists.
    return segments[1] !== "expenses";
  }

  return segments[2] === "list" && DELTA_SYNC_PROCEDURES.has(segments[1] ?? "");
}

export function getOfflineQueryStaleTime(queryKey: readonly unknown[]): number {
  // A Delta-backed query is never considered stale merely because the browser
  // was reloaded. IndexedDB hydration supplies its snapshot; the shared Delta
  // runtime reconciles changes without downloading the whole list again.
  return isDeltaSyncBackedQueryKey(queryKey) ? Number.POSITIVE_INFINITY : 30_000;
}

