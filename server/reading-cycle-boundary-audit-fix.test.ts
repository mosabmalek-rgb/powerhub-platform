import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const migration = fs.readFileSync(
  path.resolve(process.cwd(), "supabase/migrations/20261010153000_powerhub_reading_cycle_boundary_audit_fix.sql"),
  "utf8",
);

describe("reading-cycle boundary and audit hardening migration", () => {
  it("ends monthly cycles immediately before the next configured cycle start", () => {
    expect(migration).toContain("next_month_local := date_trunc('month', start_local) + interval '1 month'");
    expect(migration).toContain("next_start_day := case");
    expect(migration).toContain("end_local := next_month_local");
    expect(migration).toContain("make_interval(days => next_start_day - 1)");
  });

  it("includes the final calendar day in 10-day and 15-day monthly segments", () => {
    expect(migration).toContain("when start_day = 21 then");
    expect(migration).toContain("when start_day = 16 then");
    expect(migration).toContain("date_trunc('month', local_at) + interval '1 month' - interval '1 millisecond'");
  });

  it("keeps February day-30 clamping consistent with the configured product rule", () => {
    expect(migration).toContain("when c.monthly_start_day = 30 and extract(month from local_at)::integer = 2 then 28");
    expect(migration).toContain("when c.monthly_start_day = 30 and extract(month from next_month_local)::integer = 2 then 28");
  });

  it("records the actual owner or manager role rather than hard-coding owner", () => {
    expect(migration).toContain("select case when m.role = 'owner' then 'owner' else s.role end into v_actor_role");
    expect(migration).toContain("p_user_id, v_actor_role, 'reading_cycle'");
    expect(migration).not.toContain("p_user_id, 'owner', 'reading_cycle'");
  });

  it("validates membership expiry, owner access, active manager assignment, and tenant/site scope", () => {
    expect(migration).toContain("site.tenant_id = m.tenant_id");
    expect(migration).toContain("m.expires_at is null or m.expires_at > now()");
    expect(migration).toContain("s.archived_at is null");
    expect(migration).toContain("m.role = 'owner'");
    expect(migration).toContain("now() >= s.suspension_started_at");
    expect(migration).toContain("now() < s.suspension_ends_at");
  });

  it("keeps the RPC inaccessible to public client roles", () => {
    expect(migration).toContain("revoke execute on function public.powerhub_upsert_reading_cycle(bigint,bigint,bigint,text,integer,integer) from public, anon, authenticated");
    expect(migration).toContain("grant execute on function public.powerhub_upsert_reading_cycle(bigint,bigint,bigint,text,integer,integer) to service_role");
  });
});
