import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const calls: string[] = [];
  const filters: Array<[string, string, unknown]> = [];
  const rows: Record<string, unknown[]> = {
    platform_tweetsms_accounts: [{ id: 9, api_endpoint: "https://sms.example.test", sender_name: "PowerHub", low_balance_threshold: 100, last_provider_balance: 500, last_balance_checked_at: null, last_tested_at: null, last_error: null, is_active: false, credential_ciphertext: null, credential_iv: null }],
    platform_sms_fallback_providers: [{ id: 10, name: "مزود احتياطي", provider_key: "backup_sms", api_endpoint: null, sender_name: null, priority: 1, integration_status: "pending_contract", is_active: false, credential_ciphertext: null, credential_iv: null, last_tested_at: null, last_error: null, updated_at: "2026-08-27T00:00:00.000Z" }],
    platform_role_policies: [{ id: 11, role: "accountant", capability: "managePayroll", is_allowed: true, updated_by_user_id: 1, updated_at: "2026-08-27T00:00:00.000Z" }],
    platform_settings: [{ id: 12, setting_key: "maintenance_mode", is_enabled: false, value: null, message: null, updated_by_user_id: 1, updated_at: "2026-08-27T00:00:00.000Z" }],
    access_recovery_requests: [{ id: 13, tenant_id: 20, method: "manual_review", status: "pending", note: "مراجعة", created_at: "2026-08-27T00:00:00.000Z" }],
    platform_tariff_policies: [{ id: 14, minimum_price_per_kwh: 0.2, maximum_price_per_kwh: 0.8, effective_from: "2026-08-27T00:00:00.000Z", notification_requested: false, notes: null, created_by_user_id: 1, created_at: "2026-08-27T00:00:00.000Z" }],
    users: [{ id: 1, name: "مدير المنصة", email: "admin@example.test", role: "admin", platform_role: "platform_owner", account_status: "active", last_signed_in: "2026-08-27T00:00:00.000Z" }],
    platform_access_invitations: [{ id: 16, email: "finance@example.test", platform_role: "finance_admin", status: "invited", expires_at: "2026-08-30T00:00:00.000Z", accepted_at: null, invited_by_user_id: 1 }],
    tenants: [{ id: 20, name: "مولدات الاختبار" }],
    tenant_owner_profiles: [{ id: 50, tenant_id: 20, full_name: "مالك الاختبار", phone: "0590000000" }],
    tenant_branch_settings: [{ tenant_id: 20, is_enabled_override: true, max_branches_override: 3, disabled_behavior: "read_only" }],
    sites: [{ id: 30, tenant_id: 20, name: "فرع الاختبار" }],
    subscribers: [{ id: 40, full_name: "المشترك الاختبار", subscriber_no: "SUB-40", phone: "0590000040", tenant_id: 20 }],
    complaints: [{ id: 15, tenant_id: 20, site_id: 30, subscriber_id: 40, title: "شكوى اختبار", description: "تفاصيل اختبار", priority: "high", status: "open", assigned_user_id: 1, response: null, opened_at: "2026-08-27T00:00:00.000Z", resolved_at: null }],
    generators: [{ id: 17, code: "GEN-01", name: "مولد الاختبار", status: "active", rated_capacity_kw: 250, fuel_type: "diesel", fuel_level_liters: 80, operating_hours: 12, last_maintenance_at: null, tenant_id: 20, site_id: 30 }],
    audit_logs: [{ id: 18, action: "platform_admin_update_generator_status", entity_type: "generator", created_at: "2026-08-27T00:00:00.000Z", user_id: 1 }],
    notification_messages: [{ id: 19, tenant_id: 20, channel: "sms", event_type: "invoice_issued", last_error: "تعذر الاتصال", created_at: "2026-08-27T00:00:00.000Z", status: "failed" }],
    mobile_sync_events: [{ id: 20, tenant_id: 20, status: "needs_review", error_code: null, error_message: "تحتاج مراجعة", occurred_at: "2026-08-27T00:00:00.000Z" }],
    platform_security_events: [{ id: 21, severity: "warning", status: "open", title: "مراجعة مطلوبة", details: "تفاصيل", created_at: "2026-08-27T00:00:00.000Z" }],
  };
  const client = {
    rpc(functionName: string) {
      calls.push(`rpc:${functionName}`);
      if (functionName === "powerhub_finance_overview") return Promise.resolve({ data: [{ subscriptions: [{ status: "active", count: 2 }], collections_amount: "150.5", collections_count: 3 }], error: null });
      return Promise.resolve({ data: null, error: { message: "unknown rpc" } });
    },
    from(table: string) {
      calls.push(table);
      const result = () => Promise.resolve({ data: rows[table] ?? [], error: null, count: (rows[table] ?? []).length });
      const query = { order: () => query, limit: () => query, in: () => query, eq: (column: string, value: unknown) => { filters.push([table, column, value]); return query; }, neq: (column: string, value: unknown) => { filters.push([table, column, value]); return query; }, ilike: (column: string, value: unknown) => { filters.push([table, column, value]); return query; }, range: () => query, maybeSingle: () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null }), then: <TResult1 = { data: unknown[]; error: null }, TResult2 = never>(onfulfilled?: ((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null) => result().then(onfulfilled, onrejected) };
      return { select: (..._args: unknown[]) => query };
    },
  };
  return { calls, filters, client };
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

  it("يقرأ الشكاوى الإدارية المصفاة مع الأسماء المرجعية من Supabase دون MySQL", async () => {
    state.calls.splice(0);
    state.filters.splice(0);
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.listComplaints({ status: "open" })).resolves.toMatchObject([{ id: 15, tenantName: "مولدات الاختبار", siteName: "فرع الاختبار", subscriberName: "المشترك الاختبار", assignedUserName: "مدير المنصة" }]);
    expect(state.calls).toEqual(["complaints", "tenants", "sites", "subscribers", "users"]);
    expect(state.filters).toEqual([["complaints", "status", "open"]]);
  });

  it("يقرأ إعدادات الفروع ويعدّ الفروع النشطة من Supabase دون MySQL", async () => {
    state.calls.splice(0);
    state.filters.splice(0);
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.listTenantBranchSettings()).resolves.toMatchObject([{ tenantId: 20, tenantName: "مولدات الاختبار", ownerName: "مالك الاختبار", maxBranchesOverride: 3, currentBranchCount: 1 }]);
    expect(state.calls).toEqual(["tenants", "tenant_owner_profiles", "tenant_branch_settings", "sites"]);
    expect(state.filters).toEqual([["sites", "status", "archived"]]);
  });

  it("يقرأ دليل وصول آدمن المنصة ودعواته من Supabase دون MySQL", async () => {
    state.calls.splice(0);
    state.filters.splice(0);
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_owner" } as never, req: {} as never, res: {} as never });
    await expect(caller.platformAccessDirectory()).resolves.toMatchObject({ accounts: [{ id: 1, platformRole: "platform_owner", accountStatus: "active" }], invitations: [{ id: 16, platformRole: "finance_admin", status: "invited" }] });
    expect(state.calls).toEqual(["users", "platform_access_invitations"]);
    expect(state.filters).toEqual([["users", "role", "admin"]]);
  });

  it("يقرأ تفاصيل المولد وسجل نشاط فرعه من Supabase دون MySQL", async () => {
    state.calls.splice(0);
    state.filters.splice(0);
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.generatorDetails({ generatorId: 17 })).resolves.toMatchObject({ generator: { id: 17, tenantName: "مولدات الاختبار", siteName: "فرع الاختبار", ratedCapacityKw: "250" }, activity: [{ id: 18, userName: "مدير المنصة" }] });
    expect(state.calls).toEqual(["generators", "tenants", "sites", "audit_logs", "users"]);
    expect(state.filters).toEqual([["generators", "id", 17], ["tenants", "id", 20], ["sites", "id", 30], ["audit_logs", "site_id", 30]]);
  });

  it("ينفذ البحث العالمي المحدود من Supabase دون MySQL", async () => {
    state.calls.splice(0);
    state.filters.splice(0);
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.globalSearch({ query: "اختبار" })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 17, kind: "generator", tenantName: "مولدات الاختبار" }),
      expect.objectContaining({ id: 40, kind: "subscriber", tenantName: "مولدات الاختبار" }),
      expect.objectContaining({ id: 50, kind: "owner", tenantName: "مولدات الاختبار" }),
    ]));
    expect(state.calls).toEqual(["generators", "generators", "subscribers", "subscribers", "subscribers", "tenant_owner_profiles", "tenant_owner_profiles", "tenants"]);
    expect(state.filters).toEqual(expect.arrayContaining([["generators", "name", "%اختبار%"], ["subscribers", "full_name", "%اختبار%"], ["tenant_owner_profiles", "full_name", "%اختبار%"]]));
  });

  it("يعرض المراقبة التشغيلية من Supabase دون MySQL أو تشغيل خدمات خارجية", async () => {
    state.calls.splice(0);
    state.filters.splice(0);
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.operationalMonitoring()).resolves.toMatchObject({
      health: expect.arrayContaining([expect.objectContaining({ key: "database", state: "healthy" }), expect.objectContaining({ key: "messaging", state: "critical" })]),
      alerts: expect.arrayContaining([expect.objectContaining({ id: "message-19", tenantName: "مولدات الاختبار" }), expect.objectContaining({ id: "sync-20" }), expect.objectContaining({ id: "security-21" })]),
    });
    expect(state.calls).toEqual(["tenants", "notification_messages", "notification_messages", "mobile_sync_events", "platform_security_events", "tenants"]);
  });

  it("يقرأ الملخص المالي المركزي من دالة PostgreSQL في Supabase دون MySQL", async () => {
    state.calls.splice(0);
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "finance_admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.financeOverview()).resolves.toEqual({ subscriptions: [{ status: "active", count: 2 }], collections: { amount: 150.5, count: 3 } });
    expect(state.calls).toEqual(["rpc:powerhub_finance_overview"]);
  });
});
