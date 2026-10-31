import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261031200000_powerhub_adaptive_delta_realtime.sql"), "utf8");
const router = readFileSync(resolve(process.cwd(), "server/powerhub.ts"), "utf8");
const realtimeClient = readFileSync(resolve(process.cwd(), "client/src/lib/adaptive-delta-realtime.ts"), "utf8");
const adaptiveScheduler = readFileSync(resolve(process.cwd(), "client/src/lib/adaptive-delta-refresh.ts"), "utf8");

describe("Adaptive Delta Realtime contract", () => {
  it("returns only server-authorized tenant/site topics from the existing protected revision endpoints", () => {
    const operationalStart = router.indexOf("revisions: protectedProcedure", router.indexOf("deltaSync: router"));
    const operationalEnd = router.indexOf("pull: protectedProcedure", operationalStart);
    const operational = router.slice(operationalStart, operationalEnd);
    expect(operational).toContain("requireDeltaFuelMaintenanceReadAccess");
    expect(operational).toContain("requireDeltaOperationalReadAccess");
    expect(operational).toContain("realtimeTopic: `powerhub:tenant:${tenantId}:site:${input.siteId}`");

    const dashboardStart = router.indexOf("deltaRevision: protectedProcedure");
    const dashboardEnd = router.indexOf("activeSubscribersKpi: protectedProcedure", dashboardStart);
    const dashboard = router.slice(dashboardStart, dashboardEnd);
    expect(dashboard).toContain("requireSupabaseAllBranchesRole");
    expect(dashboard).toContain("requireSupabaseSiteRole");
    expect(dashboard).toContain("realtimeTopic: input.scope === \"all\"");
    expect(dashboard).toContain("`powerhub:tenant:${access.tenantId}:all`");
    expect(dashboard).toContain("`powerhub:tenant:${access.tenantId}:site:${input.siteId}`");
  });

  it("restricts Realtime receive to private broadcast markers and current membership/site access", () => {
    expect(migration).toContain("private = true");
    expect(migration).toContain("extension = 'broadcast'");
    expect(migration).toContain("private.powerhub_realtime_can_read_delta_topic");
    expect(migration).toContain("tm.is_active = true");
    expect(migration).toContain("tm.membership_status = 'active'");
    expect(migration).toContain("tm.expires_at > now()");
    expect(migration).toContain("public.staff_profiles");
    expect(migration).toContain("sp.is_active = true");
    expect(migration).toContain("sp.suspension_ends_at");
    expect(migration).toContain("private.powerhub_is_platform_admin()");
    expect(migration).not.toContain("CREATE POLICY powerhub_delta_revision_send");
    expect(migration).not.toContain("FOR INSERT TO authenticated");
  });

  it("emits only a generic marker from the central server-owned cursor journal", () => {
    expect(migration).toContain("AFTER INSERT OR UPDATE OF last_cursor, retained_from_cursor");
    expect(migration).toContain("realtime.send(v_payload, 'powerhub_delta_changed', v_site_topic, true)");
    expect(migration).toContain("realtime.send(v_payload, 'powerhub_delta_changed', v_tenant_topic, true)");
    expect(migration).toContain("jsonb_build_object('version', 1)");
    expect(migration).not.toContain("row_data");
    expect(migration).not.toContain("NEW.row_data");
    expect(migration).not.toContain("NEW.entity_type");
  });

  it("uses shared private channels and keeps protected revision polling as a safety net", () => {
    expect(realtimeClient).toContain("config: { private: true }");
    expect(realtimeClient).toContain("supabase.realtime.setAuth()");
    expect(realtimeClient).toContain("event: \"powerhub_delta_changed\"");
    expect(realtimeClient).toContain("payload.version !== 1");
    expect(realtimeClient).toContain("Object.keys(payload).length !== 1");
    expect(realtimeClient).toContain("const entries = new Map<string, TopicEntry>()");
    expect(adaptiveScheduler).toContain("pollingIntervalMs: 30_000");
    expect(adaptiveScheduler).toContain("realtimeFallbackMinMs: 60_000");
    expect(adaptiveScheduler).toContain("realtimeFallbackMaxMs: 120_000");
    expect(adaptiveScheduler).toContain("Realtime provides low-latency invalidation");
  });
});
