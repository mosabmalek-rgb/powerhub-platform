import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const calls: string[] = [];
  const rows: Record<string, unknown[]> = {
    platform_tweetsms_accounts: [{ id: 9, api_endpoint: "https://sms.example.test", sender_name: "PowerHub", low_balance_threshold: 100, last_provider_balance: 500, last_balance_checked_at: null, last_tested_at: null, last_error: null, is_active: false, credential_ciphertext: null, credential_iv: null }],
    platform_sms_fallback_providers: [{ id: 10, name: "مزود احتياطي", provider_key: "backup_sms", api_endpoint: null, sender_name: null, priority: 1, integration_status: "pending_contract", is_active: false, credential_ciphertext: null, credential_iv: null, last_tested_at: null, last_error: null, updated_at: "2026-08-27T00:00:00.000Z" }],
    platform_role_policies: [{ id: 11, role: "accountant", capability: "managePayroll", is_allowed: true, updated_by_user_id: 1, updated_at: "2026-08-27T00:00:00.000Z" }],
    platform_settings: [{ id: 12, setting_key: "maintenance_mode", is_enabled: false, value: null, message: null, updated_by_user_id: 1, updated_at: "2026-08-27T00:00:00.000Z" }],
    access_recovery_requests: [{ id: 13, tenant_id: 20, method: "manual_review", status: "pending", note: "مراجعة", created_at: "2026-08-27T00:00:00.000Z" }],
    platform_tariff_policies: [{ id: 14, minimum_price_per_kwh: 0.2, maximum_price_per_kwh: 0.8, effective_from: "2026-08-27T00:00:00.000Z", notification_requested: false, notes: null, created_by_user_id: 1, created_at: "2026-08-27T00:00:00.000Z" }],
    users: [{ id: 1, name: "مدير المنصة" }],
    tenants: [{ id: 20, name: "مولدات الاختبار" }],
    tenant_owner_profiles: [{ tenant_id: 20, full_name: "مالك الاختبار" }],
  };
  const client = {
    from(table: string) {
      calls.push(table);
      const result = () => Promise.resolve({ data: rows[table] ?? [], error: null });
      const query = { order: () => query, limit: () => query, in: () => query, maybeSingle: () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null }), then: <TResult1 = { data: unknown[]; error: null }, TResult2 = never>(onfulfilled?: ((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null) => result().then(onfulfilled, onrejected) };
      return { select: () => query };
    },
  };
  return { calls, client };
});

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => state.client }));
vi.mock("./db", () => ({ getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }), syncSupabaseUser: vi.fn() }));

import { adminRouter } from "./admin";

describe("إعدادات مزود الرسائل المركزي عبر Supabase", () => {
  it("يقرأ الإعداد المركزي والمزود الاحتياطي دون MySQL أو اتصال خارجي", async () => {
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.getPlatformTweetSmsAccount()).resolves.toMatchObject({ id: 9, senderName: "PowerHub", configured: false, isActive: false });
    await expect(caller.listPlatformSmsFallbackProviders()).resolves.toMatchObject([{ id: 10, providerKey: "backup_sms", configured: false, integrationStatus: "pending_contract" }]);
    expect(state.calls).toEqual(["platform_tweetsms_accounts", "platform_sms_fallback_providers"]);
  });

  it("يقرأ سياسات صلاحيات المنصة من Supabase دون MySQL", async () => {
    state.calls.splice(0);
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.rolePolicies()).resolves.toMatchObject([{ id: 11, role: "accountant", capability: "managePayroll", isAllowed: true, updatedByUserId: 1 }]);
    expect(state.calls).toEqual(["platform_role_policies"]);
  });

  it("يقرأ إعدادات المنصة والتسعيرة وطلبات الاسترداد من Supabase دون MySQL", async () => {
    state.calls.splice(0);
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.platformConfiguration()).resolves.toMatchObject({ settings: [{ settingKey: "maintenance_mode" }], recoveries: [{ id: 13, tenantName: "مولدات الاختبار", ownerName: "مالك الاختبار" }], currentTariff: { id: 14, minimumPricePerKwh: 0.2 } });
    expect(state.calls).toEqual(["platform_settings", "access_recovery_requests", "platform_tariff_policies", "tenants", "tenant_owner_profiles"]);
  });

  it("يقرأ قائمة سياسات التسعير واسم منشئها من Supabase دون MySQL", async () => {
    state.calls.splice(0);
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.listTariffPolicies()).resolves.toMatchObject([{ id: 14, minimumPricePerKwh: "0.2", maximumPricePerKwh: "0.8", createdBy: "مدير المنصة" }]);
    expect(state.calls).toEqual(["platform_tariff_policies", "users"]);
  });
});
