export type StockFilterRow = {
  warehouse_id: number | string;
  item_name?: unknown;
  sku?: unknown;
  warehouse_name?: unknown;
};

export type MovementFilterRow = {
  warehouse_id: number | string;
};

/** Applies the selected site-local warehouse and existing text search to stock balances. */
export function filterInventoryStockRows<T extends StockFilterRow>(
  rows: readonly T[],
  warehouseFilter: string,
  search: string,
): T[] {
  const query = search.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (warehouseFilter !== "all" && String(row.warehouse_id) !== warehouseFilter) return false;
    if (!query) return true;
    const searchable = [
      row.item_name,
      row.sku,
      row.warehouse_name,
    ].map((value) => String(value ?? "")).join(" ").toLocaleLowerCase();
    return searchable.includes(query);
  });
}

/** Applies the same selected warehouse to the loaded movement ledger. */
export function filterInventoryMovementRows<T extends MovementFilterRow>(
  rows: readonly T[],
  warehouseFilter: string,
): T[] {
  return warehouseFilter === "all"
    ? [...rows]
    : rows.filter((row) => String(row.warehouse_id) === warehouseFilter);
}
