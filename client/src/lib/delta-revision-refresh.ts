export type OperationalDeltaRevisionEntity =
  | "fuel_events"
  | "fuel_readings"
  | "maintenance_preventive_plans"
  | "maintenance_work_orders"
  | "inventory_purchase_headers"
  | "inventory_purchase_receipt_headers"
  | "inventory_supplier_return_headers"
  | "supplier_ledger";

export type OperationalDeltaRevisionMap = Readonly<Record<string, string>>;

/** Return only requested feeds whose server-owned cursor hash actually advanced. */
export function changedOperationalDeltaEntities(
  previous: OperationalDeltaRevisionMap,
  next: OperationalDeltaRevisionMap,
  requestedEntities: readonly OperationalDeltaRevisionEntity[],
): OperationalDeltaRevisionEntity[] {
  const seen = new Set<OperationalDeltaRevisionEntity>();
  const changed: OperationalDeltaRevisionEntity[] = [];
  for (const entity of requestedEntities) {
    if (seen.has(entity)) continue;
    seen.add(entity);
    if (typeof next[entity] === "string" && next[entity] !== previous[entity]) changed.push(entity);
  }
  return changed;
}
