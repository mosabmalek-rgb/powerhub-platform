import type { DeltaChange, DeltaEntityType, DeltaPage, DeltaCursorScope } from "./offline-delta-sync";

export type DeltaOperationalEntity = DeltaEntityType;
type Row = Record<string, unknown>;

function toNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}
function dateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}
function dateOrNow(value: unknown): Date {
  return dateOrNull(value) ?? new Date(0);
}
function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function isRow(value: unknown): value is Row {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function normalizeDeltaEntityRow(entityType: DeltaOperationalEntity, raw: Row): Row {
  switch (entityType) {
    case "sites": {
      const invoiceDueDays = optionalNumber(raw.invoice_due_days ?? raw.invoiceDueDays) ?? 14;
      const invoiceDueHours = optionalNumber(raw.invoice_due_hours ?? raw.invoiceDueHours) ??
        Math.max(1, Math.min(2160, invoiceDueDays * 24));
      return {
        id: toNumber(raw.id),
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        tenantName: String(raw.tenant_name ?? raw.tenantName ?? raw.name ?? ""),
        name: String(raw.name ?? ""),
        code: String(raw.code ?? ""),
        city: (raw.city ?? null) as string | null,
        address: (raw.address ?? null) as string | null,
        status: String(raw.status ?? "active"),
        anomalyAlertPercent: optionalNumber(raw.anomaly_alert_percent ?? raw.anomalyAlertPercent),
        invoiceDueDays,
        invoiceDueHours,
        createdAt: dateOrNow(raw.created_at ?? raw.createdAt),
      };
    }
    case "subscribers":
      return {
        id: toNumber(raw.id),
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        siteId: toNumber(raw.site_id ?? raw.siteId),
        subscriberNo: String(raw.subscriber_no ?? raw.subscriberNo ?? ""),
        clientOperationId: (raw.client_operation_id ?? raw.clientOperationId ?? null) as string | null,
        fullName: String(raw.full_name ?? raw.fullName ?? ""),
        phone: String(raw.phone ?? ""),
        whatsappNumber: (raw.whatsapp_number ?? raw.whatsappNumber ?? null) as string | null,
        address: (raw.address ?? null) as string | null,
        subscriptionType: String(raw.subscription_type ?? raw.subscriptionType ?? "residential"),
        serviceStatus: String(raw.service_status ?? raw.serviceStatus ?? "active"),
        createdAt: dateOrNow(raw.created_at ?? raw.createdAt),
        updatedAt: dateOrNow(raw.updated_at ?? raw.updatedAt),
      };
    case "generators":
      return {
        id: toNumber(raw.id),
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        siteId: toNumber(raw.site_id ?? raw.siteId),
        code: String(raw.code ?? ""),
        name: String(raw.name ?? ""),
        serialNumber: (raw.serial_number ?? raw.serialNumber ?? null) as string | null,
        ratedCapacityKw: raw.rated_capacity_kw == null && raw.ratedCapacityKw == null
          ? null : String(raw.rated_capacity_kw ?? raw.ratedCapacityKw),
        fuelType: String(raw.fuel_type ?? raw.fuelType ?? "other"),
        fuelLevelLiters: String(raw.fuel_level_liters ?? raw.fuelLevelLiters ?? 0),
        operatingHours: String(raw.operating_hours ?? raw.operatingHours ?? 0),
        status: String(raw.status ?? "active"),
        lastMaintenanceAt: dateOrNull(raw.last_maintenance_at ?? raw.lastMaintenanceAt),
        createdAt: dateOrNow(raw.created_at ?? raw.createdAt),
        updatedAt: dateOrNow(raw.updated_at ?? raw.updatedAt),
      };
    case "readings":
      return {
        id: toNumber(raw.id),
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        subscriberId: toNumber(raw.subscriber_id ?? raw.subscriberId),
        clientOperationId: (raw.client_operation_id ?? raw.clientOperationId ?? null) as string | null,
        readingAt: dateOrNow(raw.reading_at ?? raw.readingAt),
        readingValue: String(raw.reading_value ?? raw.readingValue ?? 0),
        previousReadingValue: raw.previous_reading_value == null && raw.previousReadingValue == null
          ? null : String(raw.previous_reading_value ?? raw.previousReadingValue),
        consumptionKwh: raw.consumption_kwh == null && raw.consumptionKwh == null
          ? null : String(raw.consumption_kwh ?? raw.consumptionKwh),
        captureMethod: String(raw.capture_method ?? raw.captureMethod ?? "manual"),
        imageKey: (raw.image_key ?? raw.imageKey ?? null) as string | null,
        imageHash: (raw.image_hash ?? raw.imageHash ?? null) as string | null,
        status: String(raw.status ?? "pending"),
        enteredByUserId: optionalNumber(raw.entered_by_user_id ?? raw.enteredByUserId),
        reviewedByUserId: optionalNumber(raw.reviewed_by_user_id ?? raw.reviewedByUserId),
        reviewedAt: dateOrNull(raw.reviewed_at ?? raw.reviewedAt),
        notes: (raw.notes ?? null) as string | null,
        versionNo: toNumber(raw.version_no ?? raw.versionNo),
        createdAt: dateOrNow(raw.created_at ?? raw.createdAt),
        updatedAt: dateOrNow(raw.updated_at ?? raw.updatedAt),
      };
    case "tariffs":
      return {
        id: toNumber(raw.id),
        tenantId: toNumber(raw.tenant_id ?? raw.tenantId),
        siteId: toNumber(raw.site_id ?? raw.siteId),
        name: String(raw.name ?? ""),
        code: String(raw.code ?? ""),
        pricePerKwh: String(raw.price_per_kwh ?? raw.pricePerKwh ?? 0),
        fixedFee: String(raw.fixed_fee ?? raw.fixedFee ?? 0),
        taxRate: String(raw.tax_rate ?? raw.taxRate ?? 0),
        isActive: Boolean(raw.is_active ?? raw.isActive),
        effectiveFrom: dateOrNow(raw.effective_from ?? raw.effectiveFrom),
        createdAt: dateOrNow(raw.created_at ?? raw.createdAt),
      };
  }
}

export function normalizeDeltaPage(
  entityType: DeltaOperationalEntity,
  page: DeltaPage<Row>,
): DeltaPage<Row> {
  if (page.entity_type !== entityType) throw new Error("استجابة المزامنة لا تطابق نوع البيانات المطلوب.");
  return {
    ...page,
    changes: page.changes.map((change): DeltaChange<Row> => ({
      ...change,
      row_data: change.operation === "upsert" && isRow(change.row_data)
        ? normalizeDeltaEntityRow(entityType, change.row_data)
        : null,
    })),
  };
}

export function snapshotRowsFromQuery(entityType: DeltaOperationalEntity, data: unknown): Row[] {
  if (!Array.isArray(data)) throw new Error("لقطة المزامنة ليست قائمة بيانات صالحة.");
  if (entityType !== "readings") {
    return data.filter(isRow).map((row) => normalizeDeltaEntityRow(entityType, row));
  }
  return data.flatMap((entry) => {
    if (!isRow(entry) || !isRow(entry.reading)) return [];
    return [normalizeDeltaEntityRow("readings", entry.reading)];
  });
}

function idOf(row: unknown): string | null {
  if (!isRow(row) || row.id === null || row.id === undefined) return null;
  return String(row.id);
}
function scopedTo(row: Row, scope: DeltaCursorScope) {
  if (row.tenantId !== undefined && toNumber(row.tenantId) !== scope.tenantId) return false;
  if (row.siteId !== undefined && toNumber(row.siteId) !== scope.siteId) return false;
  return true;
}

export function applyDeltaPageToList(
  entityType: DeltaOperationalEntity,
  current: readonly unknown[],
  page: DeltaPage<Row>,
  scope: DeltaCursorScope,
  subscriberRows: readonly Row[] = [],
): unknown[] {
  const byId = new Map<string, unknown>();
  for (const row of current) {
    const shaped = entityType === "readings" && isRow(row) ? row.reading : row;
    const id = idOf(shaped);
    if (id !== null) byId.set(id, row);
  }
  const subscribersById = new Map(subscriberRows.filter(isRow).map((row) => [String(row.id), row]));
  for (const change of page.changes) {
    if (change.operation === "delete") {
      if (entityType === "sites" && change.entity_id !== String(scope.siteId)) continue;
      byId.delete(change.entity_id);
      continue;
    }
    if (!isRow(change.row_data) || idOf(change.row_data) !== change.entity_id || !scopedTo(change.row_data, scope)) continue;
    if (entityType === "sites" && change.entity_id !== String(scope.siteId)) continue;
    if (entityType !== "readings") {
      byId.set(change.entity_id, change.row_data);
      continue;
    }
    const existing = byId.get(change.entity_id);
    const oldPair = isRow(existing) ? existing : null;
    const oldSubscriber = oldPair && isRow(oldPair.subscriber) ? oldPair.subscriber : null;
    const subscriberId = String(change.row_data.subscriberId);
    const subscriber = subscribersById.get(subscriberId) ??
      (oldSubscriber && String(oldSubscriber.id) === subscriberId ? oldSubscriber : null);
    // A reading is not inserted into the view cache until its parent subscriber is
    // present in the same authorized site scope. The sidecar still retains the row.
    if (!subscriber || toNumber(subscriber.siteId) !== scope.siteId || toNumber(subscriber.tenantId) !== scope.tenantId) continue;
    byId.set(change.entity_id, { reading: change.row_data, subscriber });
  }
  return [...byId.values()];
}

export function refreshReadingSubscriberProjection(
  current: readonly unknown[],
  page: DeltaPage<Row>,
  scope: DeltaCursorScope,
): unknown[] {
  const updatedSubscribers = new Map<string, Row>();
  for (const change of page.changes) {
    if (change.operation === "upsert" && isRow(change.row_data) && scopedTo(change.row_data, scope)) {
      updatedSubscribers.set(change.entity_id, change.row_data);
    }
  }
  if (!updatedSubscribers.size) return [...current];
  return current.map((item) => {
    if (!isRow(item) || !isRow(item.reading) || !isRow(item.subscriber)) return item;
    const row = updatedSubscribers.get(String(item.subscriber.id));
    return row ? { ...item, subscriber: { ...item.subscriber, ...row } } : item;
  });
}
