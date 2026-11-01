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
  // Raw HR queries include sensitive fields; only named minimized projections can opt in.
  "hr",
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
const SUBSCRIBER_DIRECTOR¶»§q«^