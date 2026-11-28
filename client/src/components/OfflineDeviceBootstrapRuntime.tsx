import { useEffect, useRef } from "react";
import { onlineManager, useQueryClient, type Query } from "@tanstack/react-query";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { getSupabaseSession } from "@/lib/supabase";
import { getPowerHubDeviceId } from "@/lib/offline-auth";
import { BRANCH_FILTER_STORAGE_KEY } from "@/hooks/useBranchFilter";
import { can, type PowerCapability, type PowerRole } from "@shared/powerhub-rbac";
import {
  bootstrapDeviceContext, deviceBootstrapScopeKey, DEVICE_BOOTSTRAP_LOCAL_SCHEMA_VERSION,
  type DeviceBootstrapNumberRange, type DeviceBootstrapPlan, type DeviceBootstrapScope,
} from "@/lib/offline-device-bootstrap";
import { hasAvailableOfflineNumberGrant, persistOfflineNumberGrant, type OfflineNumberGrant } from "@/lib/offline-number-ranges";
import { persistOfflineQueryForDeltaSync } from "@/lib/offline-query-cache";
import { getDeltaCursor, type DeltaEntityType } from "@/lib/offline-delta-sync";

type AnyRow = Record<string, unknown>;
const SNAPSHOT_ROLES: Record<"subscribers" | "generators" | "tariffs", readonly string[]> = {
  subscribers: ["owner", "manager", "accountant", "collector", "viewer"],
  generators: ["owner", "manager", "technician", "viewer"],
  tariffs: ["owner", "manager", "accountant", "viewer"],
};
const BOOTSTRAP_RANGE_COUNT = 50;

function segments(key: readonly unknown[]): string[] {
  const first = key[0];
  if (Array.isArray(first)) return first.filter((part): part is string => typeof part === "string");
  if (typeof first === "string" && first.includes(".")) return first.split(".");
  if (typeof first === "string") return key.slice(0, 3).filter((part): part is string => typeof part === "string");
  return [];
}
function findNumberProperty(value: unknown, property: string, depth = 0): number | null {
  if (depth > 5 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findNumberProperty(item, property, depth + 1); if (found !== null) return found; }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, property)) {
    const found = Number(record[property]);
    if (Number.isSafeInteger(found) && found > 0) return found;
  }
  for (const nested of Object.values(record)) {
    const found = findNumberProperty(nested, property, depth + 1);
    if (found !== null) return found;
  }
  return null;
}
function getCachedSites(client: ReturnType<typeof useQueryClient>): AnyRow[] | null {
  const query = client.getQueryCache().findAll().find((item) => {
    const path = segments(item.queryKey);
    return path[0] === "powerhub" && path[1] === "sites" && path[2] === "list" &&
      item.state.status === "success" && Array.isArray(item.state.data);
  });
  return query ? query.state.data as AnyRow[] : null;
}
function chooseSite(rows: readonly AnyRow[]): AnyRow | null {
  if (!rows.length) return null;
  let selected: number | null = null;
  try {
    const candidate = Number(window.localStorage.getItem(BRANCH_FILTER_STORAGE_KEY));
    if (Number.isSafeInteger(candidate) && candidate > 0) selected = candidate;
  } catch { /* fall back to the first server-authorized site */ }
  return rows.find((row) => Number(row.id) === selected) ?? rows[0] ?? null;
}
function validId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function findOperationalQuery(client: ReturnType<typeof useQueryClient>, entity: DeltaEntityType, siteId: number): Query | undefined {
  return client.getQueryCache().findAll().find((query) => {
    const path = segments(query.queryKey);
    if (path[0] !== "powerhub" || path[1] !== entity || path[2] !== "list") return false;
    if (entity !== "sites" && findNumberProperty(query.queryKey, "siteId") !== siteId) return false;
    return query.state.status === "success" && query.state.data !== undefined;
  });
}
async function cursorsReady(scope: DeviceBootstrapScope, entities: readonly DeltaEntityType[]): Promise<boolean> {
  const values = await Promise.all(entities.map((entityType) => getDeltaCursor({
    userId: scope.userId, tenantId: scope.tenantId, siteId: scope.siteId, entityType,
  })));
  return values.every((cursor) => cursor !== null);
}
async function waitForCursors(scope: DeviceBootstrapScope, entities: readonly DeltaEntityType[], timeoutMs: number): Promise<boolean> {
  if (await cursorsReady(scope, entities)) return true;
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: number | undefined;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("powerhub:delta-sync-status-changed", onStatus);
      resolve(value);
    };
    const check = async () => { try { if (await cursorsReady(scope, entities)) finish(true); } catch { /* retry on event/timeout */ } };
    const onStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: number; siteId?: number }>).detail;
      if (detail?.userId === scope.userId && detail.siteId === scope.siteId) void check();
    };
    window.addEventListener("powerhub:delta-sync-status-changed", onStatus);
    timer = window.setTimeout(() => finish(false), timeoutMs);
    void check();
  });
}
function errorName(error: unknown) { return error instanceof Error ? error.name : "UnknownError"; }

export function OfflineDeviceBootstrapRuntime() {
  const auth = useAuth();
  const client = useQueryClient();
  const utils = trpc.useUtils();
  const reserveOfflineNumberRange = trpc.powerhub.offlineNumbering.reserve.useMutation();
  const inFlight = useRef(false);
  const rerun = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const completedScopes = useRef(new Set<string>());

  useEffect(() => {
    const userId = validId(auth.user?.id);
    if (!auth.isOnlineAuthenticated || auth.isLoggingOut || !auth.powerHubReachable ||
        !onlineManager.isOnline() || !userId || auth.user?.role === "admin" || auth.user?.mustChangePassword) return;
    let active = true;
    const run = async () => {
      if (!active) return;
      if (inFlight.current) { rerun.current = true; return; }
      inFlight.current = true;
      try {
        do {
          rerun.current = false;
          if (!active || !onlineManager.isOnline() || !auth.powerHubReachable) break;
          const session = await getSupabaseSession();
          if (!active || !session?.user.id) break;

          let sites = getCachedSites(client);
          if (!sites) sites = await utils.powerhub.sites.list.fetch();
          if (!active || !sites?.length) break;
          const selected = chooseSite(sites);
          const siteId = validId(selected?.id);
          const tenantId = validId(selected?.tenantId ?? selected?.tenant_id);
          if (!siteId || !tenantId) break;

          const deviceId = await getPowerHubDeviceId();
          if (!active) break;
          const scope: DeviceBootstrapScope = {
            userId, tenantId, siteId, deviceId,
            localSchemaVersion: DEVICE_BOOTSTRAP_LOCAL_SCHEMA_VERSION,
          };
          const scopeKey = deviceBootstrapScopeKey(scope);
          if (completedScopes.current.has(scopeKey)) continue;
          const hadCachedSites = getCachedSites(client) !== null;

          const driver = {
            resolvePlan: async (): Promise<DeviceBootstrapPlan> => {
              let authorizedSites = sites!;
              if (hadCachedSites) {
                await utils.powerhub.sites.list.invalidate();
                authorizedSites = await utils.powerhub.sites.list.fetch();
              }
              const authorized = authorizedSites.find((site: AnyRow) => Number(site.id) === siteId);
              if (!authorized || validId(authorized.tenantId ?? authorized.tenant_id) !== tenantId) {
                throw Object.assign(new Error("تغير نطاق الفرع أثناء تهيئة الجهاز."), { name: "PowerHubBootstrapScopeChangedError" });
              }
              await utils.powerhub.staff.myAccess.invalidate({ siteId });
              const access = await utils.powerhub.staff.myAccess.fetch({ siteId });
              const role = access.role as PowerRole | undefined;
              const permissions = access.permissions as readonly PowerCapability[] | undefined;
              const ranges: DeviceBootstrapNumberRange[] = [];
              const reservationRole = role === "owner" || role === "manager" || role === "accountant";
              if (reservationRole && can(role, "manageSubscribers", permissions)) ranges.push({ numberKind: "subscriber", partitionKey: "global" });
              if (reservationRole && can(role, "issueInvoices", permissions)) ranges.push({ numberKind: "invoice", partitionKey: String(new Date().getUTCFullYear()) });
              const snapshotEntityTypes: DeltaEntityType[] = ["sites"];
              for (const entity of ["subscribers", "generators", "tariffs"] as const) {
                if (SNAPSHOT_ROLES[entity].includes(String(role))) snapshotEntityTypes.push(entity);
              }
              return { numberRanges: ranges, snapshotEntityTypes };
            },
            hasAvailableNumberRange: (scopeNow: DeviceBootstrapScope, range: DeviceBootstrapNumberRange) =>
              hasAvailableOfflineNumberGrant({
                userId: scopeNow.userId, tenantId: scopeNow.tenantId, siteId: scopeNow.siteId, deviceId: scopeNow.deviceId,
              }, range.numberKind, range.partitionKey),
            reserveNumberRange: async (scopeNow: DeviceBootstrapScope, range: DeviceBootstrapNumberRange, requestId: string) => {
              const grant = await reserveOfflineNumberRange.mutateAsync({
                siteId: scopeNow.siteId, requestId, numberKind: range.numberKind,
                partitionKey: range.partitionKey, count: BOOTSTRAP_RANGE_COUNT,
              });
              await persistOfflineNumberGrant(grant as OfflineNumberGrant);
            },
            persistInitialSnapshot: async (scopeNow: DeviceBootstrapScope, entities: readonly DeltaEntityType[]) => {
              await Promise.all(entities.map(async (entity) => {
                switch (entity) {
                  case "sites": await utils.powerhub.sites.list.fetch(); break;
                  case "subscribers": await utils.powerhub.subscribers.list.fetch({ siteId: scopeNow.siteId }); break;
                  case "generators": await utils.powerhub.generators.list.fetch({ siteId: scopeNow.siteId }); break;
                  case "tariffs": await utils.powerhub.tariffs.list.fetch({ siteId: scopeNow.siteId }); break;
                  default: throw new Error("مجال Snapshot غير مدعوم في التهيئة الأولية.");
                }
              }));
              const persisted: DeltaEntityType[] = [];
              for (const entity of entities) {
                const query = findOperationalQuery(client, entity, scopeNow.siteId);
                if (!query) throw Object.assign(new Error("نجح طلب اللقطة دون ظهور استعلام محلي قابل للحفظ."), { name: "PowerHubBootstrapSnapshotMissingQueryError" });
                await persistOfflineQueryForDeltaSync(query, session.user.id);
                persisted.push(entity);
              }
              return persisted;
            },
            hasDeltaCursors: cursorsReady,
            waitForDeltaCursors: waitForCursors,
          };
          const result = await bootstrapDeviceContext({ scope, driver });
          if (result.status === "ready") completedScopes.current.add(scopeKey);
        } while (active && rerun.current);
      } catch (error) {
        console.warn("[PowerHub] Device bootstrap deferred", { errorName: errorName(error) });
      } finally {
        inFlight.current = false;
        if (rerun.current && active) schedule();
      }
    };
    const schedule = () => {
      if (!active) return;
      if (inFlight.current) { rerun.current = true; return; }
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => { timer.current = undefined; void run(); }, 300);
    };
    const onDeltaStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: number }>).detail;
      if (detail?.userId === userId) schedule();
    };
    const onBranchChanged = () => schedule();
    window.addEventListener("powerhub:delta-sync-status-changed", onDeltaStatus);
    window.addEventListener("powerhub:branch-changed", onBranchChanged);
    void run();
    return () => {
      active = false;
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      window.removeEventListener("powerhub:delta-sync-status-changed", onDeltaStatus);
      window.removeEventListener("powerhub:branch-changed", onBranchChanged);
    };
  }, [auth.isOnlineAuthenticated, auth.isLoggingOut, auth.powerHubReachable, auth.user?.id,
      auth.user?.role, auth.user?.mustChangePassword, client, utils, reserveOfflineNumberRange.mutateAsync]);

  return null;
}
