import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const inserted: Array<{ table: string; values: unknown }> = [];
  const updated: Array<{ table: string; values: unknown }> = [];
  const deleted: string[] = [];
  let failInsertTable: string | null = null;
  const authCreateUser = vi.fn();
  const authDeleteUser = vi.fn();
  const syncProfile = vi.fn();

  const resolved = (data: unknown = null) => Promise.resolve({ data, error: null });
  const client = {
    auth: { admin: { createUser: authCreateUser, deleteUser: authDeleteUser } },
    from(table: string) {
      const selectQuery = {
        eq: () => selectQuery,
        maybeSingle: () => resolved(null),
      };
      const insertedId = table === "tenants" ? 101 : table === "sites" ? 202 : table === "generators" ? 303 : null;
      return {
        select: () => selectQuery,
        insert(values: unknown) {
          inserted.push({ table, values });
          const query = {
            select: () => ({ single: () => failInsertTable === table ? Promise.resolve({ data: null, error: new Error("forced failure") }) : resolved(insertedId === null ? null : { id: insertedId }) }),
            then: <TResult1 = { data: null; error: null }, TResult2 = never>(
              onfulfilled?: ((value: { data: null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ) => Promise.resolve({ data: null, error: failInsertTable === table ? new Error("forced failure") : null }).then(onfulfilled, onrejected),
          };
          return query;
        },
        update(values: unknown) {
          updated.push({ table, values });
          return { eq: () => resolved() };
        },
        delete: () => ({ eq: () => { deleted.push(table); return resolved(); } }),
      };
    },
  };

  return {
    inserted, updated, deleted, authCreateUser, authDeleteUser, syncProfile, client,
    get failInsertTable() { return failInsertTable; },
    set failInsertTable(value: string | null) { failInsertTable = value; },
  };
});

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => state.client }));
vi.mock("./supabase-profile", () => ({ syncSupabaseProfile: state.syncProfile }));
vi.mock("./db", () => ({ getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }), syncSupabaseUser: vi.fn() }));

import { adminRouter } from "./admin";

describe("إنشاء صاحب مولد متقدم عبر Supabase", () => {
  beforeEach(() => {
    state.inserted.splice(0);
    state.updated.splice(0);
    state.deleted.splice(0);
    state.failInsertTable = null;
    state.authCreateUser.mockReset();
    state.authDeleteUser.mockReset();
    state.syncProfile.mockReset();
    state.authCreateUser.mockResolvedValue({ data: { user: { id: "new-auth-user" } }, error: null });
    state.syncProfile.mockResolvedValue({ id: 44, role: "user", platformRole: null });
  });

  it("يعطّل مساري إنشاء اشتراك صاحب المولد قبل أي Auth أو PostgREST أو MySQL", async () => {
    const caller = adminRouter.createCaller({
      user: { id: 1, role: "admin", platformRole: "platform_owner" } as never,
      req: {} as never,
      res: {} as never,
    });

    await expect(caller.createGeneratorOwnerSubscription({
      companyName: "مولدات الاختبار", ownerName: "مالك الاختبار", identityNumber: "12345678",
      ownerPhone: "0595000000", ownerWhatsapp: "0595000000", ownerEmail: "owner@example.test",
      temporaryPassword: "Temporary!2026", plan: "starter",
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await expect(caller.createGeneratorOwnerWithTemporaryPassword({
      tenantName: "مولدات الاختبار", slug: "test-generator-owner", ownerName: "مالك الاختبار",
      ownerPhone: "0595000000", ownerWhatsapp: "0595000000", ownerEmail: "owner@example.test",
      identityNumber: "12345678", generatorName: "مولد الاختبار", generatorCode: "GEN-01",
      generatorCapacityKw: 150, generatorFuelType: "diesel", temporaryPassword: "Temporary!2026",
      siteName: "الفرع الرئيسي", siteCode: "MAIN", plan: "starter", subscriptionStatus: "trial",
      billingCycle: "monthly", autoRenew: false,
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(state.authCreateUser).not.toHaveBeenCalled();
    expect(state.inserted).toEqual([]);
    expect(state.updated).toEqual([]);
    expect(state.deleted).toEqual([]);
    expect(state.authDeleteUser).not.toHaveBeenCalled();
  });

  it("يعطّل مسارات مزودات الرسائل الخاصة بالمستأجر والتنبيه الإداري قبل أي MySQL أو اتصال خارجي", async () => {
    const caller = adminRouter.createCaller({
      user: { id: 1, role: "admin", platformRole: "platform_owner" } as never,
      req: {} as never,
      res: {} as never,
    });

    await expect(caller.testTweetSmsAccount({ tenantId: 10 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.sendOwnerUsageAlert({ tenantId: 10, message: "تنبيه استهلاك تجريبي", usagePercent: 80 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
