import { createHash } from "node:crypto";

export type DashboardKpiRevisionRow = {
  site_id: number | string;
  entity_type: string;
  last_cursor: number | string | null;
};

/** Single source of truth for the journal dependencies of dashboard KPIs. */
export const DASHBOARD_KPI_REVISION_DEPENDENCIES = {
  activeSubscribers: ["sites", "subscribers"],
  generatorStatus: ["generators"],
  periodInvoiced: ["invoices"],
  periodCollected: ["payments"],
  collectionRate: ["invoices", "payments"],
  periodOverdue: ["invoices", "payments"],
  expenses: ["expenses"],
  netCash: ["payments", "expenses"],
  currentArrears: ["invoices", "payments"],
  financialOverview: ["sites", "subscribers", "invoices", "payments", "expenses"],
  companyBalances: ["company_accounts", "company_accounts_all"],
} as const satisfies Record<string, readonly string[]>;

export type DashboardKpiRevisionKey = keyof typeof DASHBOARD_KPI_REVISION_DEPENDENCIES;

export const DASHBOARD_KPI_REVISION_ENTITIES = Array.from(
  new Set(Object.values(DASHBOARD_KPI_REVISION_DEPENDENCIES).flat()),
).sort();

const DATE_DEPENDENT_KPIS = new Set<DashboardKpiRevisionKey>([
  "periodOverdue",
  "currentArrears",
  "financialOverview",
]);

export function dashboardKpiUtcDateKey(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Dashboard KPI clock is invalid.");
  return now.toISOString().slice(0, 10);
}

export function buildDashboardKpiRevisions(
  rows: readonly DashboardKpiRevisionRow[],
  now = new Date(),
): Record<DashboardKpiRevisionKey, string> {
  const dateKey = dashboardKpiUtcDateKey(now);
  const revisions = {} as Record<DashboardKpiRevisionKey, string>;

  for (const metric of Object.keys(DASHBOARD_KPI_REVISION_DEPENDENCIES) as DashboardKpiRevisionKey[]) {
    const allowedEntities = new Set<string>(DASHBOARD_KPI_REVISION_DEPENDENCIES[metric]);
    const journal = rows
      .filter((row) => allowedEntities.has(row.entity_type))
      .map((row) => `${String(row.site_id)}:${row.entity_type}:${String(row.last_cursor ?? "0")}`)
      .sort()
      .join("|");
    const timeBucket = DATE_DEPENDENT_KPIS.has(metric) ? `date:${dateKey}` : "";
    revisions[metric] = createHash("sha256")
      .update(`${metric}:${journal || "0"}:${timeBucket}`)
      .digest("hex");
  }

  return revisions;
}
