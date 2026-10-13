import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET = "tweetsms-tenant-configuration-test-secret";
  process.env.TWEETSMS_API_KEY = "tweetsms-configuration-test-key";
  delete process.env.TWEETSMS_API_TOKEN;
});

const tweetSms = vi.hoisted(() => ({
  checkAccount: vi.fn(),
  checkBalance: vi.fn(),
  checkSender: vi.fn(),
}));

const state = vi.hoisted(() => {
  const calls: string[] = [];
  const rpcArgs: Array<{ functionName: string; args?: Record<string, unknown> }> = [];
  const filters: Array<[string, string, unknown]> = [];
  const rows: Record<string, unknown[]> = {
    platform_tweetsms_accounts: [{ id: 9, api_endpoint: "https://sms.example.test", sender_name: "PowerHub", low_balance_threshold: 100, last_provider_balance: 500, last_balance_checked_at: null, last_tested_at: null, last_error: null, is_active: false, credential_ciphertext: "test-ciphertext", credential_iv: "test-iv" }],
    platform_sms_fallback_providers: [{ id: 10, name: "مزود احتياطي", provider_key: "backup_sms", api_endpoint: null, sender_name: null, priority: 1, integration_status: "pending_contract", is_active: false, credential_ciphertext: null, credential_iv: null, last_tested_at: null, last_error: null, updated_at: "2026-08-27T00:00:00.000Z" }],
    platform_role_policies: [{ id: 11, role: "accountant", capability: "managePayroll", is_allowed: true, updated_by_user_id: 1, updated_at: "2026-08-27T00:00:00.000Z" }],
    platform_settings: [{ id: 12, setting_key: "maintenance_mode", is_enabled: false, value: null, message: null, updated_by_user_id: 1, updated_at: "2026-08-27T00:00:00.000Z" }],
    access_recovery_requests: [{ id: 13, tenant_id: 20, method: "manual_review", status: "pending", note: "مراجعة", created_at: "2026-08-27T00:00:00.000Z" }],
    platform_tariff_policies: [{ id: 14, minimum_price_per_kwh: 0.2, maximum_price_per_kwh: 0.8, effective_from: "2026-08-27T00:00:00.000Z", notification_requested: false, notes: null, created_by_user_id: 1, created_at: "2026-08-27T00:00:00.000Z" }],
    users: [{ id: 1, name: "مدير المنصة", email: "admin@example.test", role: "admin", platform_role: "platform_owner", account_status: "active", last_signed_in: "2026-08-27T00:00:00.000Z" }],
    platform_access_invitations: [{ id: 16, email: "finance@example.test", platform_role: "finance_admin", status: "invited", expires_at: "2026-08-30T00:00:00.000Z", accepted_at: null, invited_by_user_id: 1 }],
    tenants: [{ id: 20, name: "مولدات الاختبار" }],
    tenant_owner_profiles: [{ id: 50, tenant_id: 20, full_name: "مالك الاختبار", phone: "0590000000" }],
    tenant_tweetsms_accounts: [],
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
    rpc(functionName: string, args?: Record<string, unknown>) {
      calls.push(`rpc:${functionName}`);
      rpcArgs.push({ functionName, args });
      if (functionName === "powerhub_save_platform_tweetsms_account") return Promise.resolve({ data: [{ account_id: 9, is_active: false, activation_required: true }], error: null });
      if (functionName === "powerhub_record_platform_tweetsms_test") return Promise.resolve({ data: [{ account_id: 9, is_active: false, last_provider_balance: 80, last_tested_at: "2026-08-27T00:00:00.000Z", last_error: null }], error: null });
      if (functionName === "powerhub_admin_tweetsms_quota_summary") { const tenantIds = Array.isArray(args?.p_tenant_ids) ? args.p_tenant_ids as number[] : []; return Promise.resolve({ data: tenantIds.map((tenant_id) => ({ tenant_id, monthly_limit: 1000, monthly_limit_mode: "fixed", sms_feature_eligible: true, sms_feature_enabled: true, used_this_month: 10, remaining: 990 })), error: null }); }
      if (functionName === "powerhub_save_tenant_tweetsms_account") return Promise.resolve({ data: [{ account_id: 31, tenant_id: 20, is_active: false, activation_required: true }], error: null });
      if (functionName === "powerhub_record_tenant_tweetsms_test") return Promise.resolve({ data: [{ account_id: 31, is_active: false, last_provider_balance: 80, last_tested_at: "2026-08-27T00:00:00.000Z", last_error: null }], error: null });
      if (functionName === "powerhub_finance_overview") return Promise.resolve({ data: [{ subscriptions: [{ status: "active", count: 2 }], collections_amount: "150.5", collections_count: 3 }], error: null });
      if (functionName === "powerhub_tweetsms_report") return Promise.resolve({ data: [{ account: { id: 9, isActive: false, senderName: "PowerHub", lowBalanceThreshold: 100, lastProviderBalance: 80, lastBalanceCheckedAt: "2026-08-27T00:00:00.000Z", lastError: null, configured: true }, total: 3, usage_rows: [{ tenantId: 20, tenantName: "مولدات الاختبار", total: 3, submitted: 2, failed: 1 }], alerts: [{ id: 22, balance: 80, threshold: 100, status: "open", notifiedAt: "2026-08-27T00:00:00.000Z", resolvedAt: null, createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z" }] }], error: null });
      if (functionName === "powerhub_advanced_dashboard") return Promise.resolve({ data: [{ kpis: { activeGenerators: 1, subscribers: 2, dailyConsumption: 3, monthlyConsumption: 4, monthlyCollections: 5, openComplaints: 1, generatorsToReview: 0, collectionRate: 75 }, monthly_growth: [{ month: "2026-08", count: 2 }], consumption_by_region: [{ region: "غزة", consumptionKwh: 4 }], collections_by_generator: [], latest_generators: [{ id: 17, name: "مولد الاختبار", code: "GEN-01", status: "active", tenantName: "مولدات الاختبار", createdAt: "2026-08-27T00:00:00.000Z" }], recent_complaints: [{ id: 15, title: "شكوى اختبار", priority: "high", status: "open", tenantName: "مولدات الاختبار", siteName: "فرع الاختبار", openedAt: "2026-08-27T00:00:00.000Z" }], expiring_subscriptions: [{ tenantId: 20, tenantName: "مولدات الاختبار", ownerName: "مالك الاختبار", endsAt: "2026-09-01T00:00:00.000Z", status: "active" }] }], error: null });
      return Promise.resolve({ data: null, error: { message: "unknown rpc" } });
    },
    from(table: string) {
      calls.push(table);
      const result = () => Promise.resolve({ data: rows[table] ?? [], error: null, count: (rows[table] ?? []).length });
      const query = { order: () => query, limit: () => query, in: () => query, eq: (column: string, value: unknown) => { filters.push([table, column, value]); return query; }, neq: (column: string, value: unknown) => { filters.push([table, column, value]); return query; }, ilike: (column: string, value: unknown) => { filters.push([table, column, value]); return query; }, range: () => query, maybeSingle: () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null }), then: <TResult1 = { data: unknown[]; error: null }, TResult2 = never>(onfulfilled?: ((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null) => result().then(onfulfilled, onrejected) };
      return { select: (..._args: unknown[]) => query };
    },
  };
  return { calls, rpcArgs, filters, rows, client };
});

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => state.client }));
vi.mock("./db", () => ({ getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }), syncSupabaseUser: vi.fn() }));
vi.mock("./tweetsms-client", () => ({
  checkTweetSmsAccount: tweetSms.checkAccount,
  checkTweetSmsBalance: tweetSms.checkBalance,
  checkTweetSmsSender: tweetSms.checkSender,
}));

import { adminRouter } from "./admin";
import { decryptTenantCredential, encryptTenantCredential } from "./tenant-crypto";

type PlatformRole = "platform_owner" | "platform_admin" | "finance_admin";

const adminContext = (platformRole: PlatformRole = "platform_admin") => ({
  user: { id: 1, role: "admin", platformRole, accountStatus: "active" } as never,
  req: {} as never,
  res: {} as never,
});

describe("إعدادات مزود الرسائل المركزي عبر Supabase", () => {
  it("يقرأ الإعداد المركزي والمزود الاحتياطي دون MySQL أو اتصال خارجي", async () => {
    const caller = adminRouter.createCaller(adminContext());
    await expect(caller.getPlatformTweetSmsAccount()).resolves.toMatchObject({ id: 9, senderName: "PowerHub", configured: true, isActive: false });
    await expect(caller.listPlatformSmsFallbackProviders()).resolves.toMatchObject([{ id: 10, providerKey: "backup_sms", configured: false, integrationStatus: "pending_contract" }]);
    expect(state.calls).toEqual(["platform_tweetsms_accounts", "platform_sms_fallback_providers"]);
  });

  it("يحفظ إعداد TweetSMS المركزي عبر RPC من دون استدعاء MySQL أو تخزين الاعتمادات", async () => {
    state.calls.splice(0);
    state.rows.platform_tweetsms_accounts = [];
    const caller = adminRouter.createCaller(adminContext());
    await expect(caller.savePlatformTweetSmsAccount({ apiEndpoint: "https://tweetsms.ps", senderName: "PowerHub", lowBalanceThreshold: 100, isActive: true })).resolves.toEqual({ id: 9, isActive: false, activationRequired: true });
    expect(state.calls).toEqual(["rpc:powerhub_save_platform_tweetsms_account"]);
  });

  it("يفحص حساب TweetSMS المحفوظ عبر المزود ثم يسجل النتيجة في Supabase فقط", async () => {
    state.calls.splice(0);
    state.rows.platform_tweetsms_accounts = [{ id: 9, api_endpoint: "https://tweetsms.ps", sender_name: "PowerHub", low_balance_threshold: 100, last_provider_balance: null, last_balance_checked_at: null, last_tested_at: null, last_error: null, is_active: false, credential_ciphertext: null, credential_iv: null }];
    tweetSms.checkAccount.mockResolvedValueOnce({ ok: true, message: "ok" });
    tweetSms.checkSender.mockResolvedValueOnce({ ok: true, message: "ok" });
    tweetSms.checkBalance.mockResolvedValueOnce({ ok: true, message: "ok", balance: 80 });
    const caller = adminRouter.createCaller(adminContext());
    await expect(caller.testPlatformTweetSmsAccount()).resolves.toMatchObject({ ok: true, balance: 80, accountActive: false });
    expect(state.calls).toEqual(["platform_tweetsms_accounts", "rpc:powerhub_record_platform_tweetsms_test"]);
    expect(tweetSms.checkAccount).toHaveBeenCalledTimes(1);
    expect(tweetSms.checkSender).toHaveBeenCalledTimes(1);
    expect(tweetSms.checkBalance).toHaveBeenCalledTimes(1);
  });

  it("يعرض كل أصحاب المولدات لإعداد TweetSMS حتى عندما لا يملك المستأجر سجل إعدادات بعد، ولا يعيد الأسرار", async () => {
    state.calls.splice(0);
    const originalRows = {
      tenants: state.rows.tenants,
      tenant_owner_profiles: state.rows.tenant_owner_profiles,
      tenant_subscriptions: state.rows.tenant_subscriptions,
      tenant_tweetsms_accounts: state.rows.tenant_tweetsms_accounts,
    };
    state.rows.tenants = [
      { id: 20, name: "مولدات الاختبار", status: "active", created_at: "2026-08-27T00:00:00.000Z" },
      { id: 21, name: "مولد آخر", status: "active", created_at: "2026-08-26T00:00:00.000Z" },
    ];
    state.rows.tenant_owner_profiles = [
      { tenant_id: 20, full_name: "مالك مهيأ", phone: "0590000020", whatsapp_number: null, company_name: "شركة الاختبار" },
      { tenant_id: 21, full_name: "مالك جديد", phone: "0590000021", whatsapp_number: null, company_name: "شركة جديدة" },
    ];
    state.rows.tenant_subscriptions = [
      { tenant_id: 20, package_code: "basic", status: "active", ends_at: "2026-12-01T00:00:00.000Z", archived_at: null, created_at: "2026-08-27T00:00:00.000Z" },
      { tenant_id: 21, package_code: "basic", status: "active", ends_at: "2026-12-01T00:00:00.000Z", archived_at: null, created_at: "2026-08-26T00:00:00.000Z" },
    ];
    state.rows.tenant_tweetsms_accounts = [
      { id: 31, tenant_id: 20, api_endpoint: "https://tweetsms.ps", credential_ciphertext: "cipher-fixture", credential_iv: "iv-fixture", sender_name: "PowerHup", monthly_limit: 1000, is_active: false, last_tested_at: null, last_error: null, updated_at: "2026-08-27T00:00:00.000Z" },
    ];

    const caller = adminRouter.createCaller(adminContext());
    const rows = await caller.listTweetSmsAccounts();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ tenantId: 20, ownerName: "مالك مهيأ", ownerPhone: "0590000020", id: 31, configured: true, isActive: false, subscriptionStatus: "active" });
    expect(rows[1]).toMatchObject({ tenantId: 21, ownerName: "مالك جديد", ownerPhone: "0590000021", id: null, configured: false, isActive: false, subscriptionStatus: "active" });
    expect(JSON.stringify(rows)).not.toContain("cipher-fixture");
    expect(JSON.stringify(rows)).not.toContain("iv-fixture");
    expect(state.calls).toEqual(["tenants", "tenant_owner_profiles", "tenant_subscriptions", "tenant_tweetsms_accounts", "rpc:powerhub_admin_tweetsms_quota_summary"]);
    state.rows.tenants = originalRows.tenants;
    state.rows.tenant_owner_profiles = originalRows.tenant_owner_profiles;
    state.rows.tenant_subscriptions = originalRows.tenant_subscriptions;
    state.rows.tenant_tweetsms_accounts = originalRows.tenant_tweetsms_accounts;
  });

  it("يحفظ حساب TweetSMS منفصلاً للمولد بمفتاح مشفر عبر Supabase فقط", async () => {
    state.calls.splice(0);
    state.rows.tenant_tweetsms_accounts = [];
    const caller = adminRouter.createCaller(adminContext());
    await expect(caller.saveTweetSmsAccount({ tenantId: 20, apiEndpoint: "https://tweetsms.ps", apiKey: "tenant-key-123", senderName: "PowerHup", monthlyLimit: 1000, isActive: true })).resolves.toEqual({ id: 31, tenantId: 20, isActive: false, activationRequired: true });
    expect(state.calls).toEqual(["tenant_tweetsms_accounts", "rpc:powerhub_save_tenant_tweetsms_account"]);
  });

  it("يحافظ على مفتاح API الحالي عند تحديث API Secret الاختياري", async () => {
    state.calls.splice(0);
    state.rpcArgs.splice(0);
    const original = state.rows.tenant_tweetsms_accounts;
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "existing-tenant-key-123", apiSecret: "old-secret" }));
    state.rows.tenant_tweetsms_accounts = [{
      tenant_id: 20,
      credential_ciphertext: encrypted.ciphertext,
      credential_iv: encrypted.iv,
    }];

    const caller = adminRouter.createCaller(adminContext());
    await expect(caller.saveTweetSmsAccount({
      tenantId: 20,
      apiEndpoint: "https://tweetsms.ps",
      apiSecret: "new-secret",
      senderName: "PowerHup",
      monthlyLimit: 1000,
      isActive: false,
    })).resolves.toMatchObject({ tenantId: 20, activationRequired: true });

    const call = state.rpcArgs.find((entry) => entry.functionName === "powerhub_save_tenant_tweetsms_account");
    expect(call?.args?.p_credential_ciphertext).toEqual(expect.any(String));
    expect(call?.args?.p_credential_iv).toEqual(expect.any(String));
    const saved = JSON.parse(decryptTenantCredential(
      String(call?.args?.p_credential_ciphertext),
      String(call?.args?.p_credential_iv),
    )) as { apiKey: string; apiSecret?: string };
    expect(saved).toEqual({ apiKey: "existing-tenant-key-123", apiSecret: "new-secret" });
    expect(JSON.stringify(call?.args)).not.toContain("existing-tenant-key-123");
    expect(JSON.stringify(call?.args)).not.toContain("new-secret");
    state.rows.tenant_tweetsms_accounts = original;
  });

  it("يفحص حساب TweetSMS الخاص بالمولد دون MySQL أو إرسال رسالة ثم يسجل النتيجة", async () => {
    state.calls.splice(0);
    tweetSms.checkAccount.mockReset();
    tweetSms.checkSender.mockReset();
    tweetSms.checkBalance.mockReset();
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    state.rows.tenant_tweetsms_accounts = [{ tenant_id: 20, api_endpoint: "https://tweetsms.ps", credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, sender_name: "PowerHup", updated_at: "2026-08-27T00:00:00.000Z" }];
    tweetSms.checkAccount.mockResolvedValueOnce({ ok: true, message: "ok" });
    tweetSms.checkSender.mockResolvedValueOnce({ ok: true, message: "ok" });
    tweetSms.checkBalance.mockResolvedValueOnce({ ok: true, message: "ok", balance: 80 });
    const caller = adminRouter.createCaller(adminContext());
    await expect(caller.testTweetSmsAccount({ tenantId: 20 })).resolves.toMatchObject({ ok: true, balance: 80, accountActive: false });
    expect(state.calls).toEqual(["tenant_tweetsms_accounts", "rpc:powerhub_record_tenant_tweetsms_test"]);
    expect(tweetSms.checkAccount).toHaveBeenCalledTimes(1);
    expect(tweetSms.checkSender).toHaveBeenCalledTimes(1);
    expect(tweetSms.checkBalance).toHaveBeenCalledTimes(1);
  });

  it("لا يؤكد نجاح الربط إذا كان اسم المرسل مفقودًا، حتى لو أمكن تسجيل الدخول", async () => {
    state.calls.splice(0);
    state.rpcArgs.splice(0);
    tweetSms.checkAccount.mockReset();
    tweetSms.checkSender.mockReset();
    tweetSms.checkBalance.mockReset();
    const original = state.rows.tenant_tweetsms_accounts;
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    state.rows.tenant_tweetsms_accounts = [{
      tenant_id: 20,
      api_endpoint: "https://tweetsms.ps",
      credential_ciphertext: encrypted.ciphertext,
      credential_iv: encrypted.iv,
      sender_name: null,
      updated_at: "2026-08-27T00:00:00.000Z",
    }];
    tweetSms.checkAccount.mockResolvedValueOnce({ ok: true, message: "ok" });

    const caller = adminRouter.createCaller(adminContext());
    await expect(caller.testTweetSmsAccount({ tenantId: 20 })).resolves.toMatchObject({
      ok: false,
      message: "أدخل اسم المرسل المسجّل في TweetSMS قبل تأكيد الربط.",
    });
    const recordTest = state.rpcArgs.find((entry) => entry.functionName === "powerhub_record_tenant_tweetsms_test");
    expect(recordTest?.args?.p_success).toBe(false);
    expect(tweetSms.checkAccount).not.toHaveBeenCalled();
    expect(tweetSms.checkSender).not.toHaveBeenCalled();
    expect(tweetSms.checkBalance).not.toHaveBeenCalled();
    state.rows.tenant_tweetsms_accounts = original;
  });

  it("يحجب مفتاح API إذا أعاده مزود TweetSMS داخل رسالة الخطأ", async () => {
    state.calls.splice(0);
    state.rpcArgs.splice(0);
    tweetSms.checkAccount.mockReset();
    tweetSms.checkSender.mockReset();
    tweetSms.checkBalance.mockReset();
    const original = state.rows.tenant_tweetsms_accounts;
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    state.rows.tenant_tweetsms_accounts = [{
      tenant_id: 20,
      api_endpoint: "https://tweetsms.ps",
      credential_ciphertext: encrypted.ciphertext,
      credential_iv: encrypted.iv,
      sender_name: "PowerHup",
      updated_at: "2026-08-27T00:00:00.000Z",
    }];
    tweetSms.checkAccount.mockResolvedValueOnce({ ok: false, message: "Provider rejected API key tenant-key-123" });

    const caller = adminRouter.createCaller(adminContext());
    const result = await caller.testTweetSmsAccount({ tenantId: 20 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("[مخفي]");
    expect(result.message).not.toContain("tenant-key-123");
    const recordTest = state.rpcArgs.find((entry) => entry.functionName === "powerhub_record_tenant_tweetsms_test");
    expect(recordTest?.args?.p_error).toContain("[مخفي]");
    expect(JSON.stringify(recordTest?.args)).not.toContain("tenant-key-123");
    expect(tweetSms.checkSender).not.toHaveBeenCalled();
    expect(tweetSms.checkBalance).not.toHaveBeenCalled();
    state.rows.tenant_tweetsms_accounts = original;
  });

  it("يقرأ سياسات صلاحيات المنصة من Supabase دون MySQL", async () => {
    state.calls.splice(0);
    const caller = adminRouter.createCaller(adminContext());
    await expect(caller.rolePolicies()).resolves.toMatchObject([{ id: 11, role: "accountant", capability: "managePayroll", isAllowed: true, updatedByUserId: 1 }]);
    expect(state.calls).toEqual(["platform_role_policies"]);
  });

  it("يقرأ إعدادات المنصة والتسعيرة وطلبات الاسترداد من Supabase دون MySQL", async () => {
    state.calls.splice(0);
    const caller = adminRouter.createCaller(adminContext());
    await expect(caller.platformConfiguration()).resolves.toMatchObject({ settings: [{ settingKey: "maintenance_mode" }], recoveries: [{ id: 13, tenantName: "مولدات الاختبار", ownerName: "مالك الاختبار" }], currentTariff: { id: 14, minimumPricePerKwh: 0.2 } });
    expect(state.calls).toEqual(["platform_settings", "access_recovery_requests", "platform_tariff_policies", "tenants", "tenant_owner_profiles"]);
  });

  it("يقرأ قائمة سياسات التسعير واسم منشئها من Supabase دون MySQL", async () => {
    state.calls.splice(0);
    const caller = adminRouter.createCaller(adminContext());
    await expect(caller.listTariffPolicies()).resolves.toMatchObject([{ id: 14, minimumPricePerKwh: "0.2", maximumPricePerKwh: "0.8", createdBy: "مدير المنصة" }]);
    expect(state.calls).toEqual(["platform_tariff_policies", "users"]);
  });

  it("يقرأ الشكاوى الإدارية المصفاة مع الأسماء المرجعية من Supabase دون MySQL", async () => {
    state.calls.splice(0);
    state.filters.splice(0);
    const caller = adminRouter.createCaller(adminContext());
    await expect(caller.listComplaints({ status: "open" })).resolves.toMatchObject([{ id: 15, tenantName: "مولدات الاختبار", siteName: "فرع الاختبار", subscriberName: "المشترك الاختبار", assignedUserName: "مدير المنصة" }]);
    expect(state.calls).toEqual(["complaints", "tenants", "sites", "subscribers", "users"]);
    expect(state.filters).toEqual([["complaints", "status", "open"]]);
  });

  it("يقرأ إعدادات الفروع ويعدّ الفروع النشطة من Supabase دون MySQL", async () => {
    state.calls.splice(0);
    state.filters.splice(0);
    const caller = adminRouter.createCaller(adminContext());
    await expect(caller.listTenantBranchSettings()).resolves.toMatchObject([{ tenantId: 20, tenantName: "مولدات الاختبار", ownerName: "مالك الاختبار", maxBranchesOverride: 3, currentBranchCount: 1 }]);
    expect(state.calls).toEqual(["tenants", "tenant_subscriptions", "tenant_owner_profiles", "tenant_branch_settings", "sites"]);
    expect(state.filters).toEqual([["sites", "status", "archived"]]);
  });

  it("يقرأ دليل وصول آدمن المنصة ودعواته من Supabase دون MySQL", async () => {
    state.calls.splice(0);
    state.filters.splice(0);
    const caller = adminRouter.createCaller(adminContext("platform_owner"));
    await expect(caller.platformAccessDirectory()).resolves.toMatchObject({ accounts: [{ id: 1, platformRole: "platform_owner", accountStatus: "active" }], invitations: [{ id: 16, platformRole: "finance_admin", status: "invited" }] });
    expect(state.calls).toEqual(["users", "platform_access_invitations"]);
    expect(state.filters).toEqual([["users", "role", "admin"]]);
  });

  it("يقرأ تفاصيل المولد وسجل نشاط فرعه من Supabase دون MySQL", async () => {
    state.calls.splice(0);
    state.filters.splice(0);
    const caller = adminRouter.createCaller(adminContext());
    await expect(caller.generatorDetails({ generatorId: 17 })).resolves.toMatchObject({ generator: { id: 17, tenantName: "مولدات الاختبار", siteName: "فرع الاختبار", ratedCapacityKw: "250" }, activity: [{ id: 18, userName: "مدير المنصة" }] });
    expect(state.calls).toEqual(["generators", "tenants", "sites", "audit_logs", "users"]);
    expect(state.filters).toEqual([["generators", "id", 17], ["tenants", "id", 20], ["sites", "id", 30], ["audit_logs", "site_id", 30]]);
  });

  it("ينفذ البحث العالمي المحدود من Supabase دون MySQL", async () => {
    state.calls.splice(0);
    state.filters.splice(0);
    const caller = adminRouter.createCaller(adminContext());
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
    const caller = adminRouter.createCaller(adminContext());
    await expect(caller.operationalMonitoring()).resolves.toMatchObject({
      health: expect.arrayContaining([expect.objectContaining({ key: "database", state: "healthy" }), expect.objectContaining({ key: "messaging", state: "critical" })]),
      alerts: expect.arrayContaining([expect.objectContaining({ id: "message-19", tenantName: "مولدات الاختبار" }), expect.objectContaining({ id: "sync-20" }), expect.objectContaining({ id: "security-21" })]),
    });
    expect(state.calls).toEqual(["tenants", "notification_messages", "notification_messages", "mobile_sync_events", "platform_security_events", "tenants"]);
  });

  it("يقرأ الملخص المالي المركزي من دالة PostgreSQL في Supabase دون MySQL", async () => {
    state.calls.splice(0);
    const caller = adminRouter.createCaller(adminContext("finance_admin"));
    await expect(caller.financeOverview()).resolves.toEqual({ subscriptions: [{ status: "active", count: 2 }], collections: { amount: 150.5, count: 3 } });
    expect(state.calls).toEqual(["rpc:powerhub_finance_overview"]);
  });

  it("يقرأ تقرير TweetSMS المركزي المحدد بالفترة من Supabase دون MySQL أو اتصال بالمزود", async () => {
    state.calls.splice(0);
    const caller = adminRouter.createCaller(adminContext());
    await expect(caller.platformTweetSmsReport({ from: new Date("2026-08-01T00:00:00.000Z"), to: new Date("2026-08-31T23:59:59.999Z") })).resolves.toMatchObject({ account: { id: 9, configured: true, lastProviderBalance: 80 }, total: 3, usageRows: [{ tenantId: 20, submitted: 2, failed: 1 }], alerts: [{ id: 22, status: "open" }] });
    expect(state.calls).toEqual(["rpc:powerhub_tweetsms_report"]);
  });

  it("يقرأ لوحة التحليلات المركزية من دالة Supabase دون MySQL", async () => {
    state.calls.splice(0);
    const caller = adminRouter.createCaller(adminContext());
    await expect(caller.advancedDashboard()).resolves.toMatchObject({
      kpis: { activeGenerators: 1, collectionRate: 75 },
      monthlyGrowth: [{ month: "2026-08", count: 2 }],
      consumptionByRegion: [{ region: "غزة", consumptionKwh: 4 }],
      latestGenerators: [{ id: 17, tenantName: "مولدات الاختبار" }],
      recentComplaints: [{ id: 15, siteName: "فرع الاختبار" }],
      expiringSubscriptions: [{ tenantId: 20, ownerName: "مالك الاختبار" }],
    });
    expect(state.calls).toEqual(["rpc:powerhub_advanced_dashboard"]);
  });
});