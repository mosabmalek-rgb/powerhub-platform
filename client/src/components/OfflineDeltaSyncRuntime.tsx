import { useEffect, useRef } from "react";
import { onlineManager, useQueryClient, type Query } from "@tanstack/react-query";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { getSupabaseSession } from "@/lib/supabase";
import { persistOfflineQuery } from "@/lib/offline-query-cache";
import {
  clearDeltaSyncDataForUser,
  getDeltaCursor,
  pullDeltaPages,
  type DeltaCursorScope,
  type DeltaEntityType,
  type DeltaPage,
} from "@/lib/offline-delta-sync";
import {
  applyDeltaPageToList,
  normalizeDeltaPage,
  refreshReadingSubscriberProjection,
  snapshotRowsFromQuery,
  type DeltaOperationalEntity,
} from "@/lib/offline-delta-query-bridge";
import { isOfflineCacheableQueryKey } from "@/lib/offline-query-cache";

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

function queryIsSupportedList(query: Query): DeltaOperationalEntity | null {
  if (!isOfflineCacheableQueryKey(query.queryKey) || !Array.isArray(query.state.data)) return null;
  const segments = getSegments(query.queryKey);
  if (segments[0] !== "powerhub" || segments[2] !== "list") return null;
  if (segments[1] === "subscribers" || segments[1] === "generators" || segments[1] === "readings" || segments[1] === "tariffs") {
    return segments[1];
  }
  return null;
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
    const siteId = findNumberProperty(query.queryKey, "siteId");
    if (!siteId) continue;
    const data = query.state.data as unknown[];
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
  for (const query of queries) {
    const queryEntity = queryIsSupportedList(query);
    if (!queryEntity || findNumberProperty(query.queryKey, "siteId") !== scope.siteId) continue;
    const rows = query.state.data;
    if (!Array.isArray(rows)) continue;
    if (queryEntity === entityType) {
      queryClient.setQueryData(query.queryKey, applyDeltaPageToList(entityType, rows, page, scope, subscribers));
      changedQueries.add(query);
    } else if (entityType === "subscribers" && queryEntity === "readings") {
      queryClient.setQueryData(query.queryKey, refreshReadingSubscriberProjection(rows, page, scope));
      changedQueries.add(query);
    }
  }
  // The cursor is committed only after every affected durable query snapshot is
  // written, so a browser restart cannot resume beyond a change absent from cache.
  for (const query of changedQueries) await persistOfflineQuery(query, cacheOwnerId);
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
        let data: unknown;
        switch (candidate.entityType) {
          case "subscribers":
            data = await utils.powerhub.subscribers.list.fetch({ siteId: candidate.siteId });
            break;
          case "generators":
            data = await utils.powerhub.generators.list.fetch({ siteId: candidate.siteId });
            break;
          case "readings":
            data = await utils.powerhub.readings.list.fetch({ siteId: candidate.siteId });
            break;
          case "tariffs":
            data = await utils.powerhub.tariffs.list.fetch({ siteId: candidate.siteId });
            break;
        }
        // Persist the fetched full snapshot before its cursor becomes durable. If
        // the snapshot persistence fails, abort the pull and leave the prior cursor.
        const matchingQueries = queryClient.getQueryCache().findAll().filter((query) =>
          queryIsSupportedList(query) === candidate.entityType &&
          findNumberProperty(query.queryKey, "siteId") === candidate.siteId &&
          Array.isArray(query.state.data)
        );
        for (const query of matchingQueries) await persistOfflineQuery(query, cacheOwnerId);
        return snapshotRowsFromQuery(candidate.entityType, data);
      };
      await pullDeltaPages({
        scope,
        afterCursor,
        pull,
        rebuildSnapshot,
        applyPage: async (page) => patchQueryCaches(queryClient, scope, candidate.entityType, page as DeltaPage<AnyRow>, cacheOwnerId),
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
