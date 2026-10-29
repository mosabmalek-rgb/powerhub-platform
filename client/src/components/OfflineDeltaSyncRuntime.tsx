import { useEffect, useRef } from "react";
import { onlineManager, useQueryClient, type Query } from "@tanstack/react-query";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { getSupabaseSession } from "@/lib/supabase";
import { persistOfflineQueryForDeltaSync } from "@/lib/offline-query-cache";
import {
  clearDeltaSyncDataForUser,
  applyDeltaChanges,
  listDeltaEntities,
  getDeltaCursor,
  getDeltaSyncStatus,
  saveDeltaSyncStatus,
  pullDeltaPages,
  withDeltaSyncLock,
  type DeltaCursorScope,
  type DeltaEntityType,
  type DeltaPage,
} from "@/lib/offline-delta-sync";
import {
  applyDeltaPageToList,
  normalizeDeltaPage,
  refreshReadingSubscriberProjection,
  normalizeDeltaEntityRow,
  snapshotRowsFromQuery,
  projectInvoiceDeltaPage,
  projectPaymentDeltaPage,
  projectExpenseDeltaPage,
  projectReadingDeltaPage,
  refreshPaymentRelatedProjection,
  type DeltaOperationalEntity,
} from "@/lib/offline-delta-query-bridge";
import { isOfflineCacheableQueryKey } from "@/lib/offline-query-cache";
import { getOfflineQueryDeltaEntity } from "@/lib/offline-query-policy";

type AnyRow = Record<string, unknown>;
type Candidate = { entityType: DeltaOperationalEntity; siteId: number; tenantId: number };
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const SYNC_DEBOUNCE_MS = 350;

function getSegments(queryKey: readonly unknown[]): string[] {
  const first = queryKey[0];
  if (Array.isArray(first)) return first.filter((part): part is string => typeof part === "string");
  if (typeof first === "string" && first.includes(".")) return first.split(".");
  if (typeof first === "string") return queryKey.slice(0, 3).filter((part): part is string => typeof part === "string");
  return [];
}

function findNumberProperty(value: unknown, property: string, depth = 0): number | null {
  if (depth > 5 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumberProperty(item, property, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, property)) {
    const number = Number(record[property]);
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
  for (const nested of Object.values(record)) {
    const found = findNumberProperty(nested, property, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function rowTenantId(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const candidate = record.reading && typeof record.reading === "object"
    ? (record.reading as Record<string, unknown>).tenantId
    : record.tenantId ?? (record.subscriber && typeof record.subscriber === "object"
      ? (record.subscriber as Record<string, unknown>).tenantId : undefined);
  const id = Number(candidate);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getOfflineQueryInput(queryKey: readonly unknown[]): Record<string, unknown> {
  const options = queryKey[1];
  if (options && typeof options === "object" && !Array.isArray(options)) {
    const wrapper = options as Record<string, unknown>;
    const input = Object.prototype.hasOwnProperty.call(wrapper, "input") ? wrapper.input : wrapper;
    if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  }
  // tRPC's flattened cache-key shape ends with the procedure input object.
  const trailing = queryKey[queryKey.length - 1];
  return trailing && typeof trailing === "object" && !Array.isArray(trailing)
    ? trailing as Record<string, unknown>
    : {};
}

function getQueryRows(query: Query): AnyRow[] | null {
  const segments = getSegments(query.queryKey);
  const data = query.state.data;
  if (segments[0] === "powerhub" &&
      (segments[1] === "invoices" || segments[1] === "readings" || segments[1] === "payments" || segments[1] === "expenses") &&
      segments[2] === "page" && data !== null && typeof data === "object" && !Array.isArray(data)) {
    const items = (data as Record<string, unknown>).items;
    return Array.isArray(items) ? items as AnyRow[] : null;
  }
  return Array.isArray(data) ? data as AnyRow[] : null;
}

function queryIsSupportedList(query: Query): DeltaOperationalEntity | null {
  if (!isOfflineCacheableQueryKey(query.queryKey) || !getQueryRows(query)) return null;
  return getOfflineQueryDeltaEntity(query.queryKey);
}

function sortPurchaseReceiptRows(rows: AnyRow[], limit: number): AnyRow[] {
  return [...rows].sort((a, b) => {
    const left = Date.parse(String(a.received_at ?? a.receipt_date ?? ""));
    const right = Date.parse(String(b.received_at ?? b.receipt_date ?? ""));
    const leftTime = Number.isFinite(left) ? left : 0;
    const rightTime = Number.isFinite(right) ? right : 0;
    return rightTime - leftTime || Number(b.receipt_id ?? b.id) - Number(a.receipt_id ?? a.id);
  }).slice(0, limit);
}

function sortSupplierReturnRows(rows: AnyRow[], limit: number): AnyRow[] {
  return [...rows].sort((a, b) => {
    const left = Date.parse(String(a.return_date ?? ""));
    const right = Date.parse(String(b.return_date ?? ""));
    const leftTime = Number.isFinite(left) ? left : 0;
    const rightTime = Number.isFinite(right) ? right : 0;
    return rightTime - leftTime || Number(b.return_id ?? b.id) - Number(a.return_id ?? a.id);
  }).slice(0, limit);
}

function sortPurchaseHeaderRows(rows: AnyRow[], limit: number): AnyRow[] {
  return [...rows].sort((a, b) => {
    const left = Date.parse(String(a.invoice_date ?? a.invoiceDate ?? ""));
    const right = Date.parse(String(b.invoice_date ?? b.invoiceDate ?? ""));
    const leftTime = Number.isFinite(left) ? left : 0;
    const rightTime = Number.isFinite(right) ? right : 0;
    return rightTime - leftTime || Number(b.purchase_id ?? b.id) - Number(a.purchase_id ?? a.id);
  }).slice(0, limit);
}

function sortStocktakeRows(rows: AnyRow[], limit: number): AnyRow[] {
  return [...rows].sort((a, b) => {
    const left = Date.parse(String(a.created_at ?? a.createdAt ?? ""));
    const right = Date.parse(String(b.created_at ?? b.createdAt ?? ""));
    const leftTime = Number.isFinite(left) ? left : 0;
    const rightTime = Number.isFinite(right) ? right : 0;
    return rightTime - leftTime || Number(b.stocktake_id ?? b.id) - Number(a.stocktake_id ?? a.id);
  }).slice(0, limit);
}

function getLoadedSiteTenants(queries: Query[]) {
  const result = new Map<number, number>();
  for (const query of queries) {
    const segments = getSegments(query.queryKey);
    if (segments[0] !== "powerhub" || segments[1] !== "sites" || segments[2] !== "list" || !Array.isArray(query.state.data)) continue;
    for (const value of query.state.data) {
      if (!value || typeof value !== "object") continue;
      const row = value as Record<string, unknown>;
      const siteId = Number(row.id);
      const tenantId = Number(row.tenantId);
      if (Number.isSafeInteger(siteId) && siteId > 0 && Number.isSafeInteger(tenantId) && tenantId > 0) {
        result.set(siteId, tenantId);
      }
    }
  }
  return result;
}

function makeCandidates(queries: Query[]): Candidate[] {
  const tenants = getLoadedSiteTenants(queries);
  const unique = new Map<string, Candidate>();
  for (const query of queries) {
    const entityType = queryIsSupportedList(query);
    if (!entityType) continue;
    const data = getQueryRows(query) ?? [];
    if (entityType === "sites") {
      for (const site of data) {
        if (!site || typeof site !== "object") continue;
        const row = site as AnyRow;
        const siteId = Number(row.id);
        const tenantId = Number(row.tenantId);
        if (!Number.isSafeInteger(siteId) || siteId < 1 || !Number.isSafeInteger(tenantId) || tenantId < 1) continue;
        unique.set([tenantId, siteId, entityType].join(":"), { entityType, siteId, tenantId });
      }
      continue;
    }
    const queryInput = getOfflineQueryInput(query.queryKey);
    // Company-account lists are scoped to the selected branchId, while siteId
    // is the anchor used by the authorization procedure and may be a different branch.
    const siteId = entityType === "company_accounts"
      ? Number(queryInput.branchId)
      : findNumberProperty(query.queryKey, "siteId");
    if (siteId === null || !Number.isSafeInteger(siteId) || siteId < 1) continue;
    const tenantId = tenants.get(siteId) ?? data.map(rowTenantId).find((value) => value !== null) ?? null;
    if (!tenantId) continue;
    const candidate = { entityType, siteId, tenantId };
    unique.set([tenantId, siteId, entityType].join(":"), candidate);
  }
  return [...unique.values()];
}

function subscriberRowsForSite(queries: Query[], siteId: number, tenantId: number): AnyRow[] {
  for (const query of queries) {
    const segments = getSegments(query.queryKey);
    if (segments[0] !== "powerhub" || segments[1] !== "subscribers" || segments[2] !== "list") continue;
    if (findNumberProperty(query.queryKey, "siteId") !== siteId || !Array.isArray(query.state.data)) continue;
    return (query.state.data as AnyRow[]).filter((row) => Number(row.tenantId) === tenantId && Number(row.siteId) === siteId);
  }
  return [];
}

async function patchQueryCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  scope: DeltaCursorScope,
  entityType: DeltaOperationalEntity,
  page: DeltaPage<AnyRow>,
  cacheOwnerId: string,
): Promise<void> {
  const changedQueries = new Set<Query>();
  const queries = queryClient.getQueryCache().findAll();
  const subscribers = subscriberRowsForSite(queries, scope.siteId, scope.tenantId);
  let invoiceRowsAfterPage: AnyRow[] | null = null;
  let readingRowsAfterPage: AnyRow[] | null = null;
  let paymentRowsAfterPage: AnyRow[] | null = null;
  let expenseRowsAfterPage: AnyRow[] | null = null;
  if ((entityType === "invoices" || entityType === "readings" || entityType === "payments" || entityType === "expenses") && page.changes.length > 0) {
    const local = await listDeltaEntities<AnyRow>(scope);
    const nextRows = applyDeltaChanges(local.map((record) => record.rowData), page.changes);
    if (entityType === "invoices") invoiceRowsAfterPage = nextRows;
    else if (entityType === "readings") readingRowsAfterPage = nextRows;
    else if (entityType === "payments") paymentRowsAfterPage = nextRows;
    else expenseRowsAfterPage = nextRows;
  }

  for (const query of queries) {
    const queryEntity = queryIsSupportedList(query);
    if (!queryEntity) continue;
    const segments = getSegments(query.queryKey);
    if (queryEntity === "sites") {
      if (segments[0] !== "powerhub" || segments[1] !== "sites" || segments[2] !== "list") continue;
    } else if (
      (queryEntity === "company_accounts"
        ? Number(getOfflineQueryInput(query.queryKey).branchId)
        : findNumberProperty(query.queryKey, "siteId")) !== scope.siteId
    ) {
      continue;
    }
    const rows = getQueryRows(query);
    if (!rows) continue;
    if (queryEntity === entityType) {
      if (entityType === "inventory_item_units") {
        const itemId = Number(getOfflineQueryInput(query.queryKey).itemId);
        const visibleIds = new Set(rows.filter((row: AnyRow) =>
          Number(row.itemId ?? row.item_id) === itemId
        ).map((row: AnyRow) => String(row.id)));
        const scopedPage = {
          ...page,
          changes: page.changes.filter((change) => {
            if (change.operation === "upsert") {
              return Number(change.row_data?.itemId ?? change.row_data?.item_id) === itemId;
            }
            return visibleIds.has(change.entity_id);
          }),
        };
        queryClient.setQueryData(query.queryKey, applyDeltaPageToList(entityType, rows, scopedPage, scope, subscribers));
      } else if (entityType === "inventory_purchase_receipt_headers" || entityType === "inventory_supplier_return_headers") {
        const normalizedRows = rows.map(row => normalizeDeltaEntityRow(entityType, row));
        const normalizedPage = {
          ...page,
          changes: page.changes.map(change => {
            const rowData = change.row_data;
            if (change.operation !== "upsert" || rowData === null || typeof rowData !== "object" || Array.isArray(rowData)) return change;
            return { ...change, row_data: normalizeDeltaEntityRow(entityType, rowData as AnyRow) };
          }),
        };
        const nextRows = applyDeltaPageToList(entityType, normalizedRows, normalizedPage, scope, subscribers) as AnyRow[];
        const limit = Number(getOfflineQueryInput(query.queryKey).limit ?? 100);
        queryClient.setQueryData(query.queryKey, entityType === "inventory_purchase_receipt_headers"
          ? sortPurchaseReceiptRows(nextRows, limit)
          : sortSupplierReturnRows(nextRows, limit));
      } else if (entityType === "inventory_purchase_headers") {
        const normalizedRows = rows.map(row => normalizeDeltaEntityRow("inventory_purchase_headers", row));
        const normalizedPage = {
          ...page,
          changes: page.changes.map(change => {
            const rowData = change.row_data;
            if (change.operation !== "upsert" || rowData === null ||
                typeof rowData !== "object" || Array.isArray(rowData)) return change;
            return {
              ...change,
              row_data: normalizeDeltaEntityRow("inventory_purchase_headers", rowData as AnyRow),
            };
          }),
        };
        const nextRows = applyDeltaPageToList(entityType, normalizedRows, normalizedPage, scope, subscribers) as AnyRow[];
        queryClient.setQueryData(query.queryKey, sortPurchaseHeaderRows(nextRows, Number(getOfflineQueryInput(query.queryKey).limit ?? 100)));
      } else if (entityType === "inventory_stocktakes") {
        const normalizedRows = rows.map(row => normalizeDeltaEntityRow("inventory_stocktakes", row));
        const nextRows = applyDeltaPageToList(entityType, normalizedRows, page, scope, subscribers) as AnyRow[];
        queryClient.setQueryData(query.queryKey, sortStocktakeRows(nextRows, Number(getOfflineQueryInput(query.queryKey).limit ?? 100)));
      } else if (entityType === "inventory_stock_movements") {
        const scopedPage = {
          ...page,
          changes: page.changes.filter((change) => {
            if (change.operation === "upsert") {
              return Number(change.row_data?.siteId ?? change.row_data?.site_id) === scope.siteId &&
                Number(change.row_data?.tenantId ?? change.row_data?.tenant_id) === scope.tenantId;
            }
            return rows.some((row: AnyRow) => String(row.id ?? row.movement_id) === change.entity_id);
          }),
        };
        const nextRows = (applyDeltaPageToList(entityType, rows, scopedPage, scope, subscribers) as AnyRow[])
          .sort((a, b) => {
            const dateDiff = new Date(String(b.occurred_at ?? "")).getTime() - new Date(String(a.occurred_at ?? "")).getTime();
            return dateDiff || Number(b.id ?? b.movement_id) - Number(a.id ?? a.movement_id);
          })
          .slice(0, Number(getOfflineQueryInput(query.queryKey).limit ?? 100));
        queryClient.setQueryData(query.queryKey, nextRows);
      } else if (entityType === "invoices") {
        if (!invoiceRowsAfterPage) continue;
        queryClient.setQueryData(query.queryKey, projectInvoiceDeltaPage(
          invoiceRowsAfterPage, getOfflineQueryInput(query.queryKey), query.state.data, scope,
        ));
      } else if (entityType === "readings" && segments[2] === "page") {
        if (!readingRowsAfterPage) continue;
        queryClient.setQueryData(query.queryKey, projectReadingDeltaPage(readingRowsAfterPage, subscribers, getOfflineQueryInput(query.queryKey), query.state.data, scope));
      } else if (entityType === "payments" && segments[2] === "page") {
        if (!paymentRowsAfterPage) continue;
        queryClient.setQueryData(query.queryKey, projectPaymentDeltaPage(paymentRowsAfterPage, getOfflineQueryInput(query.queryKey), query.state.data, scope));
      } else if (entityType === "expenses" && segments[2] === "page") {
        if (!expenseRowsAfterPage) continue;
        queryClient.setQueryData(query.queryKey, projectExpenseDeltaPage(expenseRowsAfterPage, getOfflineQueryInput(query.queryKey), query.state.data, scope));
      } else {
        queryClient.setQueryData(query.queryKey, applyDeltaPageToList(entityType, rows, page, scope, subscribers));
      }
      changedQueries.add(query);
    } else if (entityType === "subscribers" && queryEntity === "readings") {
      queryClient.setQueryData(query.queryKey, refreshReadingSubscriberProjection(rows, page, scope));
      changedQueries.add(query);
    } else if ((entityType === "subscribers" || entityType === "invoices") && queryEntity === "payments" && segments[2] === "page") {
      queryClient.setQueryData(query.queryKey, refreshPaymentRelatedProjection(rows, page, scope, entityType));
      changedQueries.add(query);
    }
  }
  // The cursor is committed only after every affected durable query snapshot is written.
  for (const query of changedQueries) await persistOfflineQueryForDeltaSync(query, cacheOwnerId);
}

export function OfflineDeltaSyncRuntime() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const currentRun = useRef(false);
  const rerunRequested = useRef(false);
  const lastOnlineUserId = useRef<number | null>(null);
  const activeUserId = Number(auth.user?.id);
  const isAuthorizedOnline = auth.isOnlineAuthenticated && !auth.isLoggingOut &&
    auth.powerHubReachable && onlineManager.isOnline() &&
    Number.isSafeInteger(activeUserId) && activeUserId > 0;

  useEffect(() => {
    if (!isAuthorizedOnline || !Number.isSafeInteger(activeUserId) || activeUserId < 1) return;
    let disposed = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    const priorOnlineUserId = lastOnlineUserId.current;
    if (priorOnlineUserId !== null && priorOnlineUserId !== activeUserId) {
      void clearDeltaSyncDataForUser(priorOnlineUserId).catch(() => undefined);
    }
    lastOnlineUserId.current = activeUserId;

    const syncOne = async (candidate: Candidate, cacheOwnerId: string) => {
      const scope: DeltaCursorScope = {
        userId: activeUserId,
        tenantId: candidate.tenantId,
        siteId: candidate.siteId,
        entityType: candidate.entityType,
      };
      await withDeltaSyncLock(scope, async () => {
      const afterCursor = await getDeltaCursor(scope);
      const pull = async (args: { afterCursor: string | null; throughCursor: string | null; pageSize: number }) => {
        const response = await utils.powerhub.deltaSync.pull.fetch({
          siteId: candidate.siteId,
          entityType: candidate.entityType,
          afterCursor: args.afterCursor,
          throughCursor: args.throughCursor,
          pageSize: args.pageSize,
        });
        return normalizeDeltaPage(candidate.entityType, response as unknown as DeltaPage<AnyRow>);
      };
      const rebuildSnapshot = async () => {
        // Rows and cursor are read by one STABLE PostgreSQL RPC, so changes committed
        // during snapshot creation cannot fall between the snapshot and its cursor.
        const snapshot = await utils.powerhub.deltaSync.snapshot.fetch({
          siteId: candidate.siteId,
          entityType: candidate.entityType,
        });
        if (!Array.isArray(snapshot.rows) || typeof snapshot.snapshot_cursor !== "string") {
          throw new Error("استجابة لقطة المزامنة غير صالحة.");
        }
        const queryRows = candidate.entityType === "readings"
          ? snapshot.rows.flatMap((entry: any) => {
              if (!entry?.reading || !entry?.subscriber) throw new Error("لقطة القراءة تفتقد بيانات المشترك.");
              return [{
                reading: normalizeDeltaEntityRow("readings", entry.reading),
                subscriber: normalizeDeltaEntityRow("subscribers", entry.subscriber),
              }];
            })
          : snapshot.rows.map((row: any) => normalizeDeltaEntityRow(candidate.entityType, row));
        for (const row of queryRows) {
          const scoped = (candidate.entityType === "readings" ? row.subscriber : row) as Record<string, unknown> | undefined;
          const sharedInventoryEntity = candidate.entityType === "inventory_items" || candidate.entityType === "inventory_item_units" || candidate.entityType === "suppliers";
          const matchesScope = candidate.entityType === "sites"
            ? Number(scoped?.id) === candidate.siteId && Number(scoped?.tenantId) === candidate.tenantId
            : Number(scoped?.tenantId) === candidate.tenantId &&
              (sharedInventoryEntity || Number(scoped?.siteId) === candidate.siteId);
          if (!matchesScope) {
            throw new Error("لقطة المزامنة تحتوي بيانات خارج نطاق الفرع.");
          }
        }
        const matchingQueries = queryClient.getQueryCache().findAll().filter((query) => {
          if (queryIsSupportedList(query) !== candidate.entityType || !getQueryRows(query)) return false;
          if (candidate.entityType === "sites") {
            const segments = getSegments(query.queryKey);
            return segments[0] === "powerhub" && segments[1] === "sites" && segments[2] === "list";
          }
          return (candidate.entityType === "company_accounts"
            ? Number(getOfflineQueryInput(query.queryKey).branchId)
            : findNumberProperty(query.queryKey, "siteId")) === candidate.siteId;
        });
        if (matchingQueries.length === 0) throw new Error("لا يوجد استعلام قائمة لاستقبال لقطة المزامنة.");
        for (const query of matchingQueries) {
          if (candidate.entityType === "sites") {
            const current = query.state.data as AnyRow[];
            const siteRows = (queryRows as AnyRow[]).filter((row) => Number(row.id) === candidate.siteId);
            const merged = [
              ...current.filter((row) => Number(row.id) !== candidate.siteId),
              ...siteRows,
            ].sort((a, b) => {
              const aDate = a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(String(a.createdAt ?? 0)).getTime();
              const bDate = b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(String(b.createdAt ?? 0)).getTime();
              return bDate - aDate;
            });
            queryClient.setQueryData(query.queryKey, merged);
          } else if (candidate.entityType === "invoices") {
            queryClient.setQueryData(query.queryKey, projectInvoiceDeltaPage(
              queryRows as AnyRow[], getOfflineQueryInput(query.queryKey), query.state.data, scope,
            ));
          } else if (candidate.entityType === "readings" && getSegments(query.queryKey)[2] === "page") {
            queryClient.setQueryData(query.queryKey, projectReadingDeltaPage(snapshotRowsFromQuery("readings", queryRows), subscriberRowsForSite(queryClient.getQueryCache().findAll(), candidate.siteId, candidate.tenantId), getOfflineQueryInput(query.queryKey), query.state.data, scope));
          } else if (candidate.entityType === "payments" && getSegments(query.queryKey)[2] === "page") {
            queryClient.setQueryData(query.queryKey, projectPaymentDeltaPage(snapshotRowsFromQuery("payments", queryRows), getOfflineQueryInput(query.queryKey), query.state.data, scope));
          } else if (candidate.entityType === "expenses" && getSegments(query.queryKey)[2] === "page") {
            queryClient.setQueryData(query.queryKey, projectExpenseDeltaPage(snapshotRowsFromQuery("expenses", queryRows), getOfflineQueryInput(query.queryKey), query.state.data, scope));
          } else if (candidate.entityType === "inventory_purchase_receipt_headers" || candidate.entityType === "inventory_supplier_return_headers") {
            const limit = Number(getOfflineQueryInput(query.queryKey).limit ?? 100);
            queryClient.setQueryData(query.queryKey, candidate.entityType === "inventory_purchase_receipt_headers"
              ? sortPurchaseReceiptRows(queryRows as AnyRow[], limit)
              : sortSupplierReturnRows(queryRows as AnyRow[], limit));
          } else if (candidate.entityType === "inventory_purchase_headers") {
            const limit = Number(getOfflineQueryInput(query.queryKey).limit ?? 100);
            queryClient.setQueryData(query.queryKey, sortPurchaseHeaderRows(queryRows as AnyRow[], limit));
          } else if (candidate.entityType === "inventory_stocktakes") {
            const limit = Number(getOfflineQueryInput(query.queryKey).limit ?? 100);
            queryClient.setQueryData(query.queryKey, sortStocktakeRows(queryRows as AnyRow[], limit));
          } else if (candidate.entityType === "inventory_stock_movements") {
            const limit = Number(getOfflineQueryInput(query.queryKey).limit ?? 100);
            const movements = (queryRows as AnyRow[]).slice().sort((a, b) => {
              const dateDiff = new Date(String(b.occurred_at ?? "")).getTime() - new Date(String(a.occurred_at ?? "")).getTime();
              return dateDiff || Number(b.id ?? b.movement_id) - Number(a.id ?? a.movement_id);
            }).slice(0, limit);
            queryClient.setQueryData(query.queryKey, movements);
          } else if (candidate.entityType === "inventory_item_units") {
            const itemId = Number(getOfflineQueryInput(query.queryKey).itemId);
            queryClient.setQueryData(query.queryKey, queryRows.filter((row: AnyRow) => Number(row.itemId ?? row.item_id) === itemId));
          } else {
            queryClient.setQueryData(query.queryKey, queryRows);
          }
          await persistOfflineQueryForDeltaSync(query, cacheOwnerId);
        }
        return {
          cursor: snapshot.snapshot_cursor,
          rows: snapshotRowsFromQuery(candidate.entityType, queryRows),
        };
      };
      try {
        await pullDeltaPages({
          scope,
          afterCursor,
          pull,
          rebuildSnapshot,
          applyPage: async (page) => patchQueryCaches(queryClient, scope, candidate.entityType, page as DeltaPage<AnyRow>, cacheOwnerId),
        });
        const now = Date.now();
        await saveDeltaSyncStatus({
          ...scope,
          cursor: await getDeltaCursor(scope) ?? "0",
          lastSyncedAt: now,
          lastAttemptAt: now,
          outcome: "success",
        });
      } catch (error) {
        const now = Date.now();
        const previous = await getDeltaSyncStatus(scope).catch(() => undefined);
        const currentCursor = await getDeltaCursor(scope).catch(() => previous?.cursor ?? "0");
        await saveDeltaSyncStatus({
          ...scope,
          cursor: currentCursor ?? "0",
          lastSyncedAt: previous?.lastSyncedAt ?? null,
          lastAttemptAt: now,
          outcome: "failed",
          lastError: error instanceof Error ? error.message : "تعذر تنفيذ المزامنة التفاضلية.",
        }).catch((statusError) => console.warn("[PowerHub] Could not persist Delta sync status", statusError));
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("powerhub:delta-sync-status-changed", {
            detail: { userId: activeUserId, siteId: candidate.siteId },
          }));
        }
        throw error;
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("powerhub:delta-sync-status-changed", {
          detail: { userId: activeUserId, siteId: candidate.siteId },
        }));
      }
      });
    };

    const run = async () => {
      if (disposed) return;
      if (currentRun.current) {
        rerunRequested.current = true;
        return;
      }
      if (!onlineManager.isOnline() || !auth.powerHubReachable) return;
      currentRun.current = true;
      rerunRequested.current = false;
      try {
        const session = await getSupabaseSession();
        if (!session?.user.id) return;
        const cacheOwnerId = session.user.id;
        const queryList = queryClient.getQueryCache().findAll();
        const candidates = makeCandidates(queryList);
        for (const candidate of candidates) {
          if (disposed || !onlineManager.isOnline()) break;
          try {
            await syncOne(candidate, cacheOwnerId);
          } catch (error) {
            console.warn("[PowerHub] Delta sync deferred for scoped list", candidate.entityType, candidate.siteId, error);
          }
        }
      } finally {
        currentRun.current = false;
        if (rerunRequested.current && !disposed) schedule();
      }
    };

    const schedule = () => {
      if (disposed) return;
      if (currentRun.current) {
        rerunRequested.current = true;
        return;
      }
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { void run(); }, SYNC_DEBOUNCE_MS);
    };

    schedule();
    const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      if (queryIsSupportedList(event.query)) schedule();
      else {
        const segments = getSegments(event.query.queryKey);
        if (segments[0] === "powerhub" && segments[1] === "sites" && segments[2] === "list") schedule();
      }
    });
    const unsubscribeOnline = onlineManager.subscribe((online) => { if (online) schedule(); });
    const focus = () => schedule();
    window.addEventListener("focus", focus);
    interval = setInterval(schedule, SYNC_INTERVAL_MS);

    return () => {
      disposed = true;
      if (debounce) clearTimeout(debounce);
      if (interval) clearInterval(interval);
      unsubscribeCache();
      unsubscribeOnline();
      window.removeEventListener("focus", focus);
    };
  }, [activeUserId, isAuthorizedOnline, queryClient, utils, auth.powerHubReachable]);

  useEffect(() => {
    if (!auth.isLoggingOut) return;
    const previous = lastOnlineUserId.current;
    lastOnlineUserId.current = null;
    if (previous) void clearDeltaSyncDataForUser(previous).catch(() => undefined);
  }, [auth.isLoggingOut]);

  return null;
}
