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
const DELTA_SYNC_PROCEDURES = new Set(["sites", "subscribers", "generators", "readings", "tariffs", "companyAccounts", "inventory"]);

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
  if (options && typeof options === "object" && !Array.isArray(options)) {
    const wrapper = options as Record<string, unknown>;
    const input = Object.prototype.hasOwnProperty.call(wrapper, "input") ? wrapper.input : wrapper;
    if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  }
  // Support the legacy flattened query-key shape used by cache policy callers/tests:
  // ["powerhub", router, procedure, input]. Keep this fallback restricted to a
  // plain trailing object so malformed keys do not become cacheable by accident.
  const trailing = queryKey[queryKey.length - 1];
  if (trailing && typeof trailing === "object" && !Array.isArray(trailing)) {
    return trailing as Record<string, unknown>;
  }
  return null;
}

const DASHBOARD_SNAPSHOT_INPUT_KEYS: Record<string, ReadonlySet<string>> = {
  "dashboard.summary": new Set(["siteId"]),
  "dashboard.allBranchesSummary": new Set(["siteId"]),
  "dashboard.financialOverview": new Set(["siteId", "scope", "includeDetails"]),
  "dashboard.periodMetrics": new Set(["siteId", "scope", "startDate", "endDate", "includeDetails"]),
};

function isSafeDashboardRevision(queryKey: readonly unknown[], segments: string[]) {
  if (segments.length !== 3 || segments[1] !== "dashboard" || segments[2] !== "deltaRevision") return false;
  const input = getOfflineQueryInput(queryKey);
  return Boolean(input &&
    Object.keys(input).length === 2 &&
    Object.keys(input).every((key) => key === "siteId" || key === "scope") &&
    Number.isSafeInteger(input.siteId) && Number(input.siteId) > 0 &&
    (input.scope === "branch" || input.scope === "all"));
}

function isSafeDashboardSnapshot(queryKey: readonly unknown[], segments: string[]) {
  if (segments.length !== 3 || segments[1] !== "dashboard") return false;
  const procedure = `dashboard.${segments[2]}`;
  const allowedKeys = DASHBOARD_SNAPSHOT_INPUT_KEYS[procedure];
  if (!allowedKeys) return false;
  const input = getOfflineQueryInput(queryKey);
  if (!input || Object.keys(input).some((key) => !allowedKeys.has(key))) return false;
  if (!Number.isSafeInteger(input.siteId) || Number(input.siteId) < 1) return false;

  if (procedure === "dashboard.summary" || procedure === "dashboard.allBranchesSummary") {
    return Object.keys(input).length === 1;
  }
  if (input.scope !== "branch" && input.scope !== "all" || input.includeDetails !== false) return false;
  if (procedure === "dashboard.financialOverview") return Object.keys(input).length === 3;

  if (Object.keys(input).length !== 5 ||
      !isValidOfflineDate(input.startDate) ||
      !isValidOfflineDate(input.endDate) ||
      String(input.startDate) > String(input.endDate)) return false;
  return true;
}

const OPERATIONAL_OFFLINE_LIST_INPUT_KEYS: Record<string, ReadonlySet<string>> = {
  "inventory.listFuelReadings": new Set(["siteId", "generatorId", "limit"]),
  "maintenance.listPreventivePlans": new Set(["siteId", "generatorId"]),
};

function isSafeOperationalOfflineList(queryKey: readonly unknown[], segments: string[]) {
  if (segments.length !== 3) return false;
  const procedure = `${segments[1]}.${segments[2]}`;
  const allowedKeys = OPERATIONAL_OFFLINE_LIST_INPUT_KEYS[procedure];
  if (!allowedKeys) return false;
  const input = getOfflineQueryInput(queryKey);
  if (!input || Object.keys(input).some((key) => !allowedKeys.has(key))) return false;
  if (!Number.isSafeInteger(input.siteId) || Number(input.siteId) < 1) return false;
  if (input.generatorId !== undefined &&
      (!Number.isSafeInteger(input.generatorId) || Number(input.generatorId) < 1)) return false;
  if (procedure === "inventory.listFuelReadings") {
    return input.limit === 100;
  }
  return input.generatorId === undefined;
}

const INVENTORY_OFFLINE_LIST_INPUT_KEYS: Record<string, ReadonlySet<string>> = {
  "inventory.listItems": new Set(["siteId", "search", "includeInactive"]),
  "inventory.listSuppliers": new Set(["siteId", "search", "includeInactive"]),
  "inventory.listWarehouses": new Set(["siteId", "includeInactive"]),
  "inventory.listItemUnits": new Set(["siteId", "itemId", "includeInactive"]),
  "inventory.listStocktakes": new Set(["siteId", "warehouseId", "limit"]),
  "inventory.listPurchaseHeaders": new Set(["siteId", "limit"]),
  "inventory.listPurchaseReceiptHeaders": new Set(["siteId", "limit"]),
  "inventory.listSupplierReturnHeaders": new Set(["siteId", "limit"]),
};

function isSafeInventoryOfflineList(queryKey: readonly unknown[], segments: string[]) {
  if (segments.length !== 3 || segments[1] !== "inventory") return false;
  const procedure = `inventory.${segments[2]}`;
  const allowedKeys = INVENTORY_OFFLINE_LIST_INPUT_KEYS[procedure];
  if (!allowedKeys) return false;
  const input = getOfflineQueryInput(queryKey);
  if (!input || Object.keys(input).some((key) => !allowedKeys.has(key))) return false;
  if (!Number.isSafeInteger(input.siteId) || Number(input.siteId) < 1) return false;
  if (input.includeInactive !== undefined && input.includeInactive !== false) return false;
  if (procedure === "inventory.listItemUnits") {
    return Number.isSafeInteger(input.itemId) && Number(input.itemId) > 0 &&
      Object.keys(input).every((key) => ["siteId", "itemId", "includeInactive"].includes(key));
  }
  if (procedure === "inventory.listStocktakes") {
    return input.limit === 100 && input.warehouseId === undefined &&
      Object.keys(input).every((key) => ["siteId", "warehouseId", "limit"].includes(key));
  }
  if (procedure === "inventory.listPurchaseHeaders" ||
      procedure === "inventory.listPurchaseReceiptHeaders" ||
      procedure === "inventory.listSupplierReturnHeaders") {
    return input.limit === 100 &&
      Object.keys(input).every((key) => ["siteId", "limit"].includes(key));
  }
  if ((procedure === "inventory.listItems" || procedure === "inventory.listSuppliers") &&
      input.search !== undefined) return false;
  return Object.keys(input).every((key) => ["siteId", "includeInactive", "search"].includes(key));
}

function isSafeInventoryMovementList(queryKey: readonly unknown[], segments = getPowerHubQuerySegments(queryKey)) {
  if (segments.length !== 3 || segments[1] !== "inventory" || segments[2] !== "listStockMovements") return false;
  const input = getOfflineQueryInput(queryKey);
  return Boolean(input && Object.keys(input).length === 2 &&
    Object.keys(input).every((key) => key === "siteId" || key === "limit") &&
    Number.isSafeInteger(input.siteId) && Number(input.siteId) > 0 &&
    input.limit === 100);
}

function isSafeBranchScopedCompanyAccountList(queryKey: readonly unknown[]) {
  const input = getOfflineQueryInput(queryKey);
  if (!input || Object.keys(input).some((key) => !["siteId", "branchId"].includes(key))) return false;
  return Number.isSafeInteger(input.siteId) && Number(input.siteId) > 0 &&
    Number.isSafeInteger(input.branchId) && Number(input.branchId) > 0;
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
  "expenses.page": new Set(["siteId", "limit", "cursor", "startDate", "endDate", "companyAccountId"]),
};

function isValidOfflineDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Cache only bounded, site-scoped page snapshots whose inputs are explicitly
 * known. These are display snapshots, not offline financial authority. A page is
 * Delta-backed only when its key maps to a matching server feed and runtime projection.
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

  if (["readings.page", "invoices.page", "payments.page", "expenses.page"].includes(procedure) &&
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

function isSafeStableOfflineList(queryKey: readonly unknown[], segments: string[]) {
  if (segments.length !== 3 || segments[2] !== "list" || !CACHEABLE_PROCEDURES.has(segments[1] ?? "")) return false;
  const input = getOfflineQueryInput(queryKey);
  if (segments[1] === "sites") {
    // Site listing is the authenticated user's own accessible-site index; it has no
    // caller-supplied tenant/site filter and must not accept extra input fields.
    if (!input) return true;
    return Object.keys(input).length === 1 && input.type === "query";
  }
  if (!input || Object.keys(input).length !== 1 || !Object.prototype.hasOwnProperty.call(input, "siteId")) return false;
  return Number.isSafeInteger(input.siteId) && Number(input.siteId) > 0;
}

export function isOfflineCacheableQueryKey(queryKey: readonly unknown[]) {
  const segments = getPowerHubQuerySegments(queryKey);
  if (segments[0] !== "powerhub") return false;
  // Explicit site-scoped page allowlist is evaluated before BLOCKED_PROCEDURES:
  // only the named read pages above may persist, never their list/mutation/summaries.
  if (isSafeScopedOfflinePage(queryKey, segments)) return true;
  if (segments.some((value) => BLOCKED_PROCEDURES.has(value))) return false;

  // Dashboard totals are persisted as bounded display snapshots only. The UI
  // revalidates them against the server-side change journal; they are never
  // reconstructed from partial client-side financial rows.
  // Inventory catalog lists are persisted only in their default active,
  // unfiltered form and use the matching tenant/site-scoped Delta catalog feed.
  if (isSafeOperationalOfflineList(queryKey, segments)) return true;
  if (isSafeInventoryOfflineList(queryKey, segments)) return true;
  if (isSafeInventoryMovementList(queryKey, segments)) return true;
  if (isSafeDashboardRevision(queryKey, segments)) return true;
  if (isSafeDashboardSnapshot(queryKey, segments)) return true;

  // Cache only the unfiltered, fixed-size subscriber directory pages. Search
  // results and type-filtered pages may contain a user's ad-hoc selections and
  // are intentionally not persisted. The input contract also bounds page size
  // and rejects extra query fields so unrelated procedures cannot opt in.
  if (segments[1] === "subscribers" && segments[2] === "directoryPage") {
    return isSafeUnfilteredSubscriberDirectoryPage(queryKey);
  }

  // Company-account Delta currently reconciles explicit single-branch lists only.
  // All-branch/date-filtered lists remain uncached until their exact projection is
  // materialized by the matching Delta scope.
  if (segments[1] === "companyAccounts" && segments[2] === "list") {
    return isSafeBranchScopedCompanyAccountList(queryKey);
  }

  // Only stable whole-list query shapes are persisted. Search pages, details,
  // summaries, mutations and other methods under an otherwise cacheable router
  // must opt in explicitly rather than inheriting permission from the router name.
  return isSafeStableOfflineList(queryKey, segments);
}

export function isOfflineDashboardRevisionQueryKey(queryKey: readonly unknown[]) {
  const segments = getPowerHubQuerySegments(queryKey);
  return isSafeDashboardRevision(queryKey, segments);
}

export function isOfflineDashboardSnapshotQueryKey(queryKey: readonly unknown[]) {
  const segments = getPowerHubQuerySegments(queryKey);
  return isSafeDashboardSnapshot(queryKey, segments);
}

export function isDeltaSyncBackedQueryKey(queryKey: readonly unknown[]) {
  const segments = getPowerHubQuerySegments(queryKey);
  if (!isOfflineCacheableQueryKey(queryKey) || segments.length < 3 || segments[0] !== "powerhub") return false;

  // Reading and invoice history are materialized from their full scoped Delta
  // snapshots into the exact keyset page shape expected by the UI.
  if ((segments[1] === "readings" || segments[1] === "invoices" || segments[1] === "payments" || segments[1] === "expenses") && segments[2] === "page") return true;

  if (isSafeOperationalOfflineList(queryKey, segments)) return true;

  if (segments[1] === "inventory") {
    return ["listItems", "listItemUnits", "listSuppliers", "listWarehouses"].includes(segments[2] ?? "") ||
      (segments[2] === "listStocktakes" && isSafeInventoryOfflineList(queryKey, segments)) ||
      (segments[2] === "listPurchaseHeaders" && isSafeInventoryOfflineList(queryKey, segments)) ||
      (segments[2] === "listPurchaseReceiptHeaders" && isSafeInventoryOfflineList(queryKey, segments)) ||
      (segments[2] === "listSupplierReturnHeaders" && isSafeInventoryOfflineList(queryKey, segments)) ||
      isSafeInventoryMovementList(queryKey, segments);
  }
  return segments[2] === "list" && DELTA_SYNC_PROCEDURES.has(segments[1] ?? "");
}

export function getOfflineQueryStaleTime(queryKey: readonly unknown[]): number {
  // A Delta-backed query is never considered stale merely because the browser
  // was reloaded. IndexedDB hydration supplies its snapshot; the shared Delta
  // runtime reconciles changes without downloading the whole list again.
  return isDeltaSyncBackedQueryKey(queryKey) ? Number.POSITIVE_INFINITY : 30_000;
}



/** Canonical mapping shared by the Delta runtime and its query-policy tests. */
export type OfflineQueryDeltaEntity =
  | "sites"
  | "subscribers"
  | "generators"
  | "readings"
  | "tariffs"
  | "invoices"
  | "payments"
  | "expenses"
  | "company_accounts"
  | "inventory_items"
  | "inventory_item_units"
  | "suppliers"
  | "inventory_warehouses"
  | "inventory_stock_movements"
  | "inventory_stocktakes"
  | "inventory_purchase_headers"
  | "inventory_purchase_receipt_headers"
  | "inventory_supplier_return_headers"
  | "fuel_readings"
  | "maintenance_preventive_plans";

/**
 * Returns the server change-feed entity only when this exact query key is
 * cacheable and Delta-backed. Keep UI procedure names mapped explicitly to
 * backend entity names so a stale-time declaration cannot silently outpace
 * runtime support.
 */
export function getOfflineQueryDeltaEntity(queryKey: readonly unknown[]): OfflineQueryDeltaEntity | null {
  if (!isDeltaSyncBackedQueryKey(queryKey)) return null;
  const segments = getPowerHubQuerySegments(queryKey);
  if (segments[2] === "page") {
    if (segments[1] === "readings" || segments[1] === "invoices" ||
        segments[1] === "payments" || segments[1] === "expenses") {
      return segments[1];
    }
    return null;
  }
  if (isSafeOperationalOfflineList(queryKey, segments)) {
    return segments[1] === "inventory" ? "fuel_readings" : "maintenance_preventive_plans";
  }
  if (segments[1] === "inventory") {
    if (segments[2] === "listStockMovements") return isSafeInventoryMovementList(queryKey, segments) ? "inventory_stock_movements" : null;
    if (segments[2] === "listStocktakes") return isSafeInventoryOfflineList(queryKey, segments) ? "inventory_stocktakes" : null;
    if (segments[2] === "listPurchaseHeaders") return isSafeInventoryOfflineList(queryKey, segments) ? "inventory_purchase_headers" : null;
    if (segments[2] === "listPurchaseReceiptHeaders") return isSafeInventoryOfflineList(queryKey, segments) ? "inventory_purchase_receipt_headers" : null;
    if (segments[2] === "listSupplierReturnHeaders") return isSafeInventoryOfflineList(queryKey, segments) ? "inventory_supplier_return_headers" : null;
    if (segments[2] === "listItems") return "inventory_items";
    if (segments[2] === "listItemUnits") return "inventory_item_units";
    if (segments[2] === "listSuppliers") return "suppliers";
    if (segments[2] === "listWarehouses") return "inventory_warehouses";
    return null;
  }
  if (segments[2] !== "list") return null;
  if (segments[1] === "companyAccounts") return "company_accounts";
  if (segments[1] === "sites" || segments[1] === "subscribers" ||
      segments[1] === "generators" || segments[1] === "readings" ||
      segments[1] === "tariffs") return segments[1] as "sites" | "subscribers" | "generators" | "readings" | "tariffs";
  return null;
}
