import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }),
  profile: { id: 7, user_id: 42, site_id: 3 },
  updates: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("./db", () => ({ getDb: state.getDb }));
vi.mock("./powerhub-supabase", () => ({
  requireSupabaseSiteRole: vi.fn(async () => ({ tenantId: 10, role: "owner" })),
  writeSupabaseAudit: vi.fn(async (input: Record<string, unknown>) => { state.audits.push(input); }),
}));
vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      expect(table).toBe("staff_profiles");
      const query: any = {
        select() { return query; },
        eq() { return query; },
        or() { return query; },
        maybeSingle: async () => ({ data: state.profile, error: null }),
        update(values: Record<string, unknown>) {
          state.updates.push(values);
          return query;
        },
        then(resolve: (value: { data: null; error: null }) => unknown) {
          return Promise.resolve(resolve({ data: null, error: null }));
        },
      };
      return query;
    },
  }),
}));

describe("PowerHub staff suspension Supabase runtime", () => {
  it("executes suspend through Supabase without calling MySQL", async () => {
    const { powerhubStaffSuspensionRuntimeRouter } = await import("./powerhub-staff-suspension-runtime");
    const mutation = (powerhubStaffSuspensionRuntimeRouter as any)._def.record.suspend;

    const result = await mutation._def.resolver({
      ctx: { user: { id: 99 } },
      input: {
        siteId: 3,
        profileId: 7,
        startsAt: "2026-09-12T10:00:00.000Z",
        endsAt: "2026-09-13T10:00:00.000Z",
      },
    });

    expect(result.success).toBe(true);
    expect(state.getDb).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      suspension_started_at: "2026-09-12T10:00:00.000Z",
      suspension_ends_at: "2026-09-13T10:00:00.000Z",
    });
    expect(state.audits[0]).toMatchObject({
      action: "suspend_until",
      entityType: "staff_profile",
      entityId: "7",
    });
  });

  it("executes clearSuspension through Supabase without calling MySQL", async () => {
    state.updates.length = 0;
    state.audits.length = 0;

    const { powerhubStaffSuspensionRuntimeRouter } = await import("./powerhub-staff-suspension-runtime");
    const mutation = (powerhubStaffSuspensionRuntimeRouter as any)._def.record.clearSuspension;

    const result = await mutation._def.resolver({
      ctx: { user: { id: 99 } },
      input: { siteId: 3, profileId: 7 },
    });

    expect(result).toEqual({ success: true });
    expect(state.getDb).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      suspension_started_at: null,
      suspension_ends_at: null,
    });
    expect(state.audits[0]).toMatchObject({
      action: "clear_suspension",
      entityType: "staff_profile",
      entityId: "7",
    });
  });

  it("rejects an invalid suspension window before writing", async () => {
    const { powerhubStaffSuspensionRuntimeRouter } = await import("./powerhub-staff-suspension-runtime");
    const mutation = (powerhubStaffSuspensionRuntimeRouter as any)._def.record.suspend;

    await expect(mutation._def.resolver({
      ctx: { user: { id: 99 } },
      input: {
        siteId: 3,
        profileId: 7,
        startsAt: "2026-09-13T10:00:00.000Z",
        endsAt: "2026-09-12T10:00:00.000Z",
      },
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(state.getDb).not.toHaveBeenCalled();
  });
});
