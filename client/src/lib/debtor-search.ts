export type DebtorSearchRow = { subscriber?: string | null; invoiceNo?: string | null };

export function filterDebtorsByQuery<T extends DebtorSearchRow>(rows: T[], query: string) {
  const normalized = query.trim().toLocaleLowerCase("ar");
  if (!normalized) return rows;
  return rows.filter((row) => `${row.subscriber ?? ""} ${row.invoiceNo ?? ""}`.toLocaleLowerCase("ar").includes(normalized));
}
