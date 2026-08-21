export type DebtorSearchRow = { subscriber?: string | null; invoiceNo?: string | null };
export type DebtorStatusFilter = "all" | "overdue" | "partial" | "upcoming";
export type DebtorSort = "priority" | "balance" | "age";
type ActionableDebtorRow = DebtorSearchRow & { outstanding?: number; ageDays?: number; isOverdue?: boolean; partialInvoices?: number };

export function filterDebtorsByQuery<T extends DebtorSearchRow>(rows: T[], query: string) {
  const normalized = query.trim().toLocaleLowerCase("ar");
  if (!normalized) return rows;
  return rows.filter((row) => `${row.subscriber ?? ""} ${row.invoiceNo ?? ""}`.toLocaleLowerCase("ar").includes(normalized));
}

export function filterAndSortDebtors<T extends ActionableDebtorRow>(rows: T[], query: string, status: DebtorStatusFilter, sort: DebtorSort) {
  const statusRows = filterDebtorsByQuery(rows, query).filter((row) => {
    if (status === "partial") return Number(row.partialInvoices ?? 0) > 0;
    if (status === "overdue") return Boolean(row.isOverdue) && Number(row.partialInvoices ?? 0) === 0;
    if (status === "upcoming") return !row.isOverdue && Number(row.partialInvoices ?? 0) === 0;
    return true;
  });
  if (sort === "balance") return [...statusRows].sort((left, right) => Number(right.outstanding ?? 0) - Number(left.outstanding ?? 0));
  if (sort === "age") return [...statusRows].sort((left, right) => Number(right.ageDays ?? 0) - Number(left.ageDays ?? 0));
  return statusRows;
}
