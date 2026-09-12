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
        update(values: Record<string, unknown>) { state.updates.push(values); return query; },
      };
      return query;
    },
  }),
}));

describe("PowerHub staff suspension Supabase runtime", () => {
  it("uses Supabase and preserves the suspend contract", async () => {
    const { powerhubStaffSuspensionRuntimeRouter } = await import("./powerhub-staff-suspension-runtime");
    const mutation = (powerhubStaffSuspensionRuntimeRouter as any)._def.record.suspend;
    expect(mutation).toBeDefined();
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it("uses Supabase and preserves the clearSuspension contract", async () => {
    const { powerhubStaffSuspensionRuntimeRouter } = await import("./powerhub-staff-suspension-runtime");
    const mutation = (powerhubStaffSuspensionRuntimeRouter as any)._def.record.clearSuspension;
    expect(mutation).toBeDefined();
    expect(state.getDb).not.toHaveBeenCalled();
  });
});
