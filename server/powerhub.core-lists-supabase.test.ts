import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const inserts: Array<{ table: string; values: unknown }> = [];
  const updates: Array<{ table: string; values: unknown }> = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const site = { id: 10, tenant_id: 20, name: "الفرع الرئيسي", code: "MAIN", city: "غزة", address: null, status: "active", anomaly_alert_percent: 50, invoice_due_days: 14, created_at: "2026-08-01T00:00:00.000Z" };
  const subscriber = { id: 30, tenant_id: 20, site_id: 10, subscriber_no: "MAIN-001", client_operation_id: null, full_name: "مشترك الاختبار", phone: "+970595000000", whatsapp_number: null, address: null, subscription_type: "residential", service_status: "active", created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" };
  const tables: Record<string, unknown[]> = {
    sites: [site], subscribers: [subscriber],
    tariffs: [{ id: 40, tenant_id: 20, site_id: 10, name: "التعرفة الأساسية", code: "BASE", price_per_kwh: 1.25, fixed_fee: 0, tax_rate: 0, is_active: true, effective_from: "2026-08-01T00:00:00.000Z", created_at: "2026-08-01T00:00:00.000Z" }],
    generators: [{ id: 50, tenant_id: 20, site_id: 10, code: "GEN-1", name: "مولد الاختبار", serial_number: null, rated_capacity_kw: 150, fuel_type: "diesel", fuel_level_liters: 0, operating_hours: 0, status: "active", last_maintenance_at: null, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" }],
    meter_readings: [{ id: 60, tenant_id: 20, subscriber_id: 30, client_operation_id: null, reading_at: "2026-08-02T00:00:00.000Z", reading_value: 100, previous_reading_value: 90, consumption_kwh: 10, capture_method: "manual", image_key: null, image_hash: null, status: "pending_review", entered_by_user_id: 1, reviewed_by_user_id: null, reviewed_at: null, notes: null, version_no: 1, created_at: "2026-08-02T00:00:00.000Z", updated_at: "2026-08-02T00:00:00.000Z" }],
    invoices: [{ id: 70, tenant_id: 20, site_id: 10, subscriber_id: 30, reading_id: 60, tariff_id: 40, invoice_no: "MAIN-202608-0001", client_operation_id: null, billing_period: "2026-08", issue_date: "2026-08-02T00:00:00.000Z", due_date: "2026-08-16T00:00:00.000Z", previous_reading: 90, current_reading: 100, status: "issued", total_amount: 100, paid_amount: 25, balance_due: 75, consumption_kwh: 10, price_per_kwh: 10, fixed_fee: 0, tax_amount: 0, discount_amount: 0, created_by_user_id: 1, created_at: "2026-08-02T00:00:00.000Z", updated_at: "2026-08-02T00:00:00.000Z" }],
    expenses: [{ id: 80, tenant_id: 20, site_id: 10, generator_id: null, category: "fuel", description: "وقود", amount: 15, occurred_at: "2026-08-03T00:00:00.000Z", reference_no: null, created_by_user_id: 1, created_at: "2026-08-03T00:00:00.000Z" }],
    notification_messages: [{ id: 90, subscriber_id: 30, status: "failed" }],
    tenant_tweetsms_accounts: [{ tenant_id: 20, sender_name: "PowerHub", monthly_limit: 1000, is_active: true, credential_ciphertext: "configured", last_error: null }],
    sms_package_requests: [],
    payments: [{ id: 81, tenant_id: 20, site_id: 10, subscriber_id: 30, invoice_id: 70, payment_no: "PAY-202608-0001", client_operation_id: null, amount: 25, payment_method: "cash", transfer_from_account: null, transfer_from_type: null, transfer_to_account: null, transfer_to_type: null, reference_no: "REF-1", receipt_image_key: null, receipt_image_hash: null, status: "completed", collected_by_user_id: 1, collector_session_id: null, paid_at: "2026-08-03T00:00:00.000Z", created_at: "2026-08-03T00:00:00.000Z" }],
    company_accounts: [{ id: 90, tenant_id: 20, name: "كاش", account_type: "cash", phone_number: null, color: "#64748b", opening_balance: 100, is_active: true, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" }],
    company_account_sites: [{ account_id: 90, site_id: 10 }],
    account_transactions: [{ id: 91, tenant_id: 20, account_id: 90, transaction_type: "collection", amount: 25, description: "تحصيل الفاتورة PAY-202608-0001", reference_no: "REF-1", related_payment_id: 81, related_account_id: null, created_by_user_id: 1, occurred_at: "2026-08-03T00:00:00.000Z", created_at: "2026-08-03T00:00:00.000Z" }],
    collector_sessions: [{ id: 96, tenant_id: 20, site_id: 10, collector_user_id: 1, status: "open", opening_cash: 5, expected_cash: 5, declared_cash: null, variance_amount: null, opened_at: "2026-08-03T00:00:00.000Z", closed_at: null, notes: null, closed_by_user_id: null, created_at: "2026-08-03T00:00:00.000Z", updated_at: "2026-08-03T00:00:00.000Z" }],
    financial_settlements: [{ id: 97, tenant_id: 20, site_id: 10, period_start: "2026-08-01T00:00:00.000Z", period_end: "2026-08-31T23:59:59.999Z", total_collected: 100, total_expenses: 20, book_profit: 80, actual_cash: 75, difference: -5, notes: "تسوية دورية", status: "draft", created_by_user_id: 1, approved_by_user_id: null, locked_at: null, created_at: "2026-08-31T23:59:59.999Z", updated_at: "2026-08-31T23:59:59.999Z" }],
    users: [{ id: 1, role: "admin" }], tenant_members: [{ tenant_id: 20, user_id: 1, role: "owner", is_active: true, membership_status: "active" }], tenant_subscriptions: [{ tenant_id: 20, plan: "professional" }], platform_settings: [{ setting_key: "branch_feature", is_enabled: true, value: { defaultLimit: { starter: 1, professional: 3, enterprise: 10 } } }], tenant_branch_settings: [],
    tenants: [{ id: 20, plan: "starter" }],
  };
  const resolved = (data: unknown) => Promise.resolve({ data, error: null });
  const client = {
    from(table: string) {
      const rows = tables[table] ?? [];
      let filteredRows = rows;
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { filteredRows = filteredRows.filter((row) => !(column in (row as Record<string, unknown>)) || (row as Record<string, unknown>)[column] === value); return query; },
        in: (column: string, values: unknown[]) => { filteredRows = filteredRows.filter((row) => !(column in (row as Record<string, unknown>)) || values.includes((row as Record<string, unknown>)[column])); return query; },
        is: () => query,
        neq: (column: string, value: unknown) => { filteredRows = filteredRows.filter((row) => !(column in (row as Record<string, unknown>)) || (row as Record<string, unknown>)[column] !== value); return query; },
        order: () => query,
        gte: () => query,
        lte: () => query,
        limit: () => query,
        maybeSingle: () => resolved(filteredRows[0] ?? null),
        then: <TResult1 = { data: unknown[]; error: null }, TResult2 = never>(
          onfulfilled?: ((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) => resolved(filteredRows).then(onfulfilled, onrejected),
      };
      const updateQuery = {
        eq: () => updateQuery,
        then: <TResult1 = { data: null; error: null }, TResult2 = never>(
          onfulfilled?: ((value: { data: null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) => resolved(null).then(onfulfilled, onrejected),
      };
      return {
        ...query,
        insert(values: unknown) {
          inserts.push({ table, values });
          const id = table === "tariffs" ? 41 : table === "generators" ? 51 : 91;
          return {
            select: () => ({ single: () => resolved({ id }) }),
            then: <TResult1 = { data: null; error: null }, TResult2 = never>(
              onfulfilled?: ((value: { data: null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ) => resolved(null).then(onfulfilled, onrejected),
          };
        },
        update(values: unknown) { updates.push({ table, values }); return updateQuery; },
      };
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      if (name === "powerhub_update_subscriber") return resolved([{ updated_at: "2026-08-03T00:00:00.000Z", replayed: false }]);
      if (name === "powerhub_create_reading") return resolved([{ reading_id: 61, consumption_kwh: 15, status: "pending_review", replayed: false }]);
      if (name === "powerhub_update_pending_reading") return resolved([{ consumption_kwh: 20, updated_at: "2026-08-04T00:00:00.000Z" }]);
      if (name === "powerhub_delete_pending_reading") return resolved(null);
      if (name === "powerhub_approve_reading") return resolved([{ reading_id: 60, version_no: 2 }]);
      if (name === "powerhub_issue_invoice_from_reading") return resolved([{ invoice_id: 71, invoice_no: "PH-MAIN-202608-00002", total_amount: 150, replayed: false }]);
      if (name === "powerhub_create_payment") return resolved([{ payment_id: 81, replayed: false }]);
      if (name === "powerhub_create_expense") return resolved([{ expense_id: 82 }]);
      if (name === "powerhub_create_financial_settlement") return resolved([{ settlement_id: 97 }]);
      if (name === "powerhub_set_financial_settlement_status") return resolved([{ settlement_id: 97 }]);
      if (name === "powerhub_exceptional_locked_edit") return resolved([{ before_data: { id: 82, description: "وصف سابق" }, after_data: { id: 82, description: "وصف مصحح" } }]);
      if (["powerhub_update_site_anomaly", "powerhub_update_site"].includes(name)) return resolved([{ site_id: 10 }]);
      if (name === "powerhub_create_site") return resolved([{ site_id: 11 }]);
      if (["powerhub_update_company_account_phone", "powerhub_update_company_account_opening_balance", "powerhub_update_company_account_sites"].includes(name)) return resolved([{ account_id: 92 }]);
      if (name === "powerhub_create_company_account") return resolved([{ account_id: 92 }]);
      if (name === "powerhub_add_account_movement") return resolved([{ transaction_id: 93 }]);
      if (name === "powerhub_transfer_company_accounts") return resolved([{ from_transaction_id: 94, to_transaction_id: 95 }]);
      if (name === "powerhub_close_collector_session") return resolved([{ expected_cash: 10, variance_amount: 0 }]);
      if (name === "powerhub_request_sms_package") return resolved([{ request_id: 98, request_status: "pending" }]);
      return resolved([{ subscriber_id: 31, subscriber_no: "MAIN-NEW", replayed: false }]);
    },
  };
  return { client, tables, inserts, updates, rpcCalls };
});

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => state.client }));
vi.mock("./db", () => ({ getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }), syncSupabaseUser: vi.fn() }));

import { powerhubRouter } from "./powerhub";

describe("قوائم التشغيل الأساسية عبر Supabase", () => {
  beforeEach(() => {
    state.tables.users = [{ id: 1, role: "admin" }];
    state.inserts.splice(0);
    state.updates.splice(0);
    state.rpcCalls.splice(0);
  });

  it("يعرض الفروع والمشتركين والتعرفة والمولدات والقراءات دون استدعاء MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.sites.list()).resolves.toMatchObject([{ id: 10, tenantId: 20, createdAt: expect.any(Date) }]);
    await expect(caller.subscribers.list({ siteId: 10 })).resolves.toMatchObject([{ id: 30, subscriberNo: "MAIN-001", fullName: "مشترك الاختبار", createdAt: expect.any(Date) }]);
    await expect(caller.tariffs.list({ siteId: 10 })).resolves.toMatchObject([{ id: 40, pricePerKwh: "1.25", effectiveFrom: expect.any(Date) }]);
    await expect(caller.generators.list({ siteId: 10 })).resolves.toMatchObject([{ id: 50, ratedCapacityKw: "150", createdAt: expect.any(Date) }]);
    await expect(caller.readings.list({ siteId: 10 })).resolves.toMatchObject([{ reading: { id: 60, consumptionKwh: "10", readingAt: expect.any(Date) }, subscriber: { id: 30, fullName: "مشترك الاختبار" } }]);
    await expect(caller.invoices.list({ siteId: 10 })).resolves.toMatchObject([{ id: 70, invoiceNo: "MAIN-202608-0001", totalAmount: "100", issueDate: expect.any(Date) }]);
    await expect(caller.payments.list({ siteId: 10 })).resolves.toMatchObject([{ payment: { id: 81, amount: "25", paidAt: expect.any(Date), receiptImageUrl: null }, subscriber: { id: 30 }, invoiceNo: "MAIN-202608-0001" }]);
    await expect(caller.companyAccounts.list({ siteId: 10 })).resolves.toMatchObject([{ id: 90, balance: 125, linkedSites: [{ siteId: 10, siteName: "الفرع الرئيسي" }], transactions: [{ id: 91, occurredAt: expect.any(Date) }] }]);
    await expect(caller.expenses.list({ siteId: 10 })).resolves.toMatchObject([{ id: 80, category: "fuel", amount: "15", occurredAt: expect.any(Date) }]);
    await expect(caller.dashboard.summary({ siteId: 10 })).resolves.toEqual({ subscribers: 1, generators: { active: 1, maintenance: 0 }, financial: { invoiced: 100, collected: 25, outstanding: 75, expenses: 15, operatingProfit: 10 }, energyKwh: 10, failedNotifications: 1 });
  });

  it("يعرض تقرير النطاق الزمني للفرع من Supabase دون استدعاء MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.reports.range({ siteId: 10, startDate: "2026-08-01", endDate: "2026-08-31" })).resolves.toMatchObject({
      range: { startDate: "2026-08-01", endDate: "2026-08-31" },
      summary: { invoiced: 100, collected: 25, outstanding: 75, energyKwh: 10, expenseTotal: 15, operatingProfit: 10 },
      collectors: [{ name: "محصل غير محدد", count: 1, amount: 25 }],
      topDebtors: [{ subscriber: "مشترك الاختبار", subscriberNo: "MAIN-001", invoiceNo: "MAIN-202608-0001", balanceDue: 75 }],
      paymentDetails: [{ paymentNo: "PAY-202608-0001", amount: 25 }],
    });
  });

  it("يعرض التقرير الشهري للفرع من Supabase دون استدعاء MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.reports.monthly({ siteId: 10, billingPeriod: "2026-08" })).resolves.toMatchObject({
      summary: { invoiced: 100, collected: 25, outstanding: 75, energyKwh: 10, expenseTotal: 15, operatingProfit: 10 },
      collectors: [{ name: "محصل غير محدد", count: 1, amount: 25 }],
      topDebtors: [{ subscriber: "مشترك الاختبار", subscriberNo: "MAIN-001", invoiceNo: "MAIN-202608-0001", balanceDue: 75 }],
    });
  });

  it("يعرض تقرير جميع الأفرع من Supabase ضمن نطاق المستأجر", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.reports.allBranchesRange({ siteId: 10, startDate: "2026-08-01", endDate: "2026-08-31" })).resolves.toMatchObject({
      scope: { branchCount: 1 },
      summary: { invoiced: 100, collected: 25, outstanding: 75, energyKwh: 10, expenseTotal: 15, operatingProfit: 10 },
      branchSummaries: [{ siteId: 10, branchName: "الفرع الرئيسي", invoiced: 100, collected: 25 }],
    });
  });

  it("يرفض عرض بيانات الفرع لمستخدم لا يملك عضوية Supabase فعالة", async () => {
    state.tables.users = [{ id: 2, role: "user" }];
    state.tables.tenant_members = [];
    const caller = powerhubRouter.createCaller({ user: { id: 2, role: "user" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscribers.list({ siteId: 10 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ينشئ تعرفة ومولداً ويحدّث المولد عبر Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.tariffs.create({ siteId: 10, name: "تعرفة جديدة", code: "NEW", pricePerKwh: 1.5, fixedFee: 0, taxRate: 0 })).resolves.toEqual({ id: 41 });
    await expect(caller.generators.create({ siteId: 10, code: "GEN-2", name: "مولد جديد", ratedCapacityKw: "200", fuelType: "diesel" })).resolves.toEqual({ id: 51 });
    await expect(caller.generators.update({ siteId: 10, id: 50, name: "مولد محدث", ratedCapacityKw: "160", fuelLevelLiters: "20", operatingHours: "10", status: "maintenance" })).resolves.toEqual({ success: true });
    expect(state.inserts).toEqual(expect.arrayContaining([expect.objectContaining({ table: "tariffs" }), expect.objectContaining({ table: "generators" }), expect.objectContaining({ table: "audit_logs" })]));
    expect(state.updates).toEqual(expect.arrayContaining([expect.objectContaining({ table: "generators", values: expect.objectContaining({ status: "maintenance" }) })]));
  });

  it("يحدّث إعدادات الفرع عبر Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.sites.updateAnomalyAlert({ siteId: 10, anomalyAlertPercent: 70 })).resolves.toEqual({ success: true, anomalyAlertPercent: 70 });
    await expect(caller.sites.updateBranch({ siteId: 10, name: "الفرع المحدث", code: "MAIN", city: "غزة", address: "العنوان", status: "active", invoiceDueDays: 21 })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "powerhub_update_site_anomaly", args: expect.objectContaining({ p_tenant_id: 20, p_anomaly_alert_percent: 70 }) }),
      expect.objectContaining({ name: "powerhub_update_site", args: expect.objectContaining({ p_invoice_due_days: 21, p_status: "active" }) }),
    ]));
  });

  it("ينشئ فرعاً عبر Supabase دون MySQL مع عضوية مالك صالحة", async () => {
    state.tables.tenant_members = [{ tenant_id: 20, user_id: 1, role: "owner", is_active: true, membership_status: "active" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.sites.create({ name: "الفرع الثاني", code: "BR2", city: "غزة", address: "العنوان" })).resolves.toEqual({ id: 11 });
    expect(state.rpcCalls).toEqual([expect.objectContaining({ name: "powerhub_create_site", args: expect.objectContaining({ p_tenant_id: 20, p_name: "الفرع الثاني", p_code: "BR2" }) })]);
  });

  it("يقرأ سياسة تعدد الأفرع من Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.sites.branchPolicy({ siteId: 10 })).resolves.toMatchObject({ isEnabled: true, planLimit: 3, maxBranches: 3, currentCount: 1, remaining: 2 });
  });

  it("يعطّل اختبار الرسائل والجدولة الموروثين صراحةً", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.messaging.testConnection({ siteId: 10, channel: "sms", provider: "tweetsms", credential: "credential-long-enough" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.messaging.configureInvoiceAutoSend({ siteId: 10, enabled: false })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("يعرض حصة SMS واستهلاكها وطلب الحزمة من Supabase فقط", async () => {
    state.tables.notification_messages = [
      { id: 90, tenant_id: 20, channel: "sms", status: "submitted", created_at: "2026-08-25T08:00:00.000Z" },
      { id: 91, tenant_id: 20, channel: "sms", status: "failed", created_at: "2026-08-25T09:00:00.000Z" },
    ];
    state.tables.sms_package_requests = [{ id: 97, tenant_id: 20, status: "approved", requested_messages: 500, approved_messages: 500, note: "مراجعة", created_at: "2026-08-20T00:00:00.000Z", reviewed_at: "2026-08-21T00:00:00.000Z" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.messaging.smsQuota({ siteId: 10 })).resolves.toMatchObject({ senderName: "PowerHub", total: 1000, used: 1, remaining: 999, configured: true });
    await expect(caller.messaging.smsDailyUsage({ siteId: 10 })).resolves.toMatchObject({ total: 1000, used: 1, remaining: 999, points: expect.any(Array) });
    await expect(caller.messaging.currentSmsPackageRequest({ siteId: 10 })).resolves.toMatchObject({ id: 97, status: "approved", requestedMessages: 500, approvedMessages: 500, createdAt: expect.any(Date) });
  });

  it("ينشئ طلب حزمة SMS عبر دالة Supabase الذرية دون MySQL أو مزود خارجي", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.messaging.requestSmsPackage({ siteId: 10, requestedMessages: 1000, note: "طلب اختبار" })).resolves.toEqual({ id: 98, status: "pending" });
    expect(state.rpcCalls).toContainEqual({ name: "powerhub_request_sms_package", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_requested_messages: 1000 }) });
  });

  it("يعرض إعدادات الرسائل والقوالب وسجل الجدولة من Supabase دون Heartbeat أو MySQL", async () => {
    state.tables.tenant_messaging_configurations = [{ id: 95, tenant_id: 20, channel: "sms", provider: "tweetsms", sender_id: "PowerHub", phone_number_id: null, template_name: "invoice", receipt_template_name: "receipt", subscriber_reference_template_name: null, is_active: false, auto_send_after_approval: false, auto_send_cron: null, schedule_cron_task_uid: null, updated_at: "2026-08-25T00:00:00.000Z" }];
    state.tables.messaging_schedule_runs = [{ id: 96, tenant_id: 20, configuration_id: 95, status: "success", scanned: 2, submitted: 0, failed: 0, skipped: 2, error: null, task_uid: null, started_at: "2026-08-25T00:00:00.000Z", finished_at: "2026-08-25T00:01:00.000Z" }];
    state.tables.platform_settings = [{ setting_key: "invoice_delivery_channels", is_enabled: false, value: { sms: false, whatsapp: false }, message: "الإرسال الخارجي معطل" }];
    state.tables.tenant_invoice_message_templates = [{ id: 97, tenant_id: 20, channel: "sms", event_type: "invoice_issued", body: "فاتورتك جاهزة", is_active: true, created_at: "2026-08-20T00:00:00.000Z", updated_at: "2026-08-20T00:00:00.000Z" }];
    state.tables.tenant_payment_receipt_message_templates = [{ id: 98, tenant_id: 20, channel: "sms", body: "تم استلام الدفعة", is_active: true, created_at: "2026-08-20T00:00:00.000Z", updated_at: "2026-08-20T00:00:00.000Z" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.messaging.listConfigurations({ siteId: 10 })).resolves.toMatchObject([{ id: 95, channel: "sms", isActive: false, updatedAt: expect.any(Date) }]);
    await expect(caller.messaging.listScheduleRuns({ siteId: 10, limit: 20 })).resolves.toMatchObject([{ id: 96, submitted: 0, startedAt: expect.any(Date), finishedAt: expect.any(Date) }]);
    await expect(caller.messaging.deliveryPolicy({ siteId: 10 })).resolves.toMatchObject({ configured: true, message: "الإرسال الخارجي معطل" });
    await expect(caller.messaging.listInvoiceTemplates({ siteId: 10 })).resolves.toMatchObject([{ id: 97, body: "فاتورتك جاهزة", isActive: true, createdAt: expect.any(Date) }]);
    await expect(caller.messaging.listPaymentReceiptTemplates({ siteId: 10 })).resolves.toMatchObject([{ id: 98, body: "تم استلام الدفعة", isActive: true, createdAt: expect.any(Date) }]);
  });

  it("ينشئ المشترك بالدالة الذرية في Supabase من دون تشغيل عامل الرسائل الموروث", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscribers.create({ siteId: 10, fullName: "مشترك جديد", phone: "+970595123456", subscriptionType: "residential", clientOperationId: "11111111-1111-4111-8111-111111111111" }))
      .resolves.toEqual({ id: 31, subscriberNo: "MAIN-NEW", referenceNotifications: [] });
    expect(state.rpcCalls).toEqual([expect.objectContaining({ name: "powerhub_create_subscriber", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_quota_limit: 100 }) })]);
    expect(state.inserts.some((entry) => entry.table === "notification_messages")).toBe(false);
  });

  it("يحدّث المشترك بالدالة الذرية في Supabase من دون استدعاء MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscribers.update({ siteId: 10, id: 30, fullName: "مشترك محدث", phone: "+970595123456", address: "غزة", subscriptionType: "commercial", serviceStatus: "active", clientOperationId: "22222222-2222-4222-8222-222222222222", expectedUpdatedAt: new Date("2026-08-01T00:00:00.000Z") }))
      .resolves.toEqual({ success: true, updatedAt: new Date("2026-08-03T00:00:00.000Z") });
    expect(state.rpcCalls).toEqual([expect.objectContaining({ name: "powerhub_update_subscriber", args: expect.objectContaining({ p_tenant_id: 20, p_subscriber_id: 30, p_service_status: "active" }) })]);
  });

  it("يسجل قراءة يدوية بالدالة الذرية في Supabase من دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.readings.create({ siteId: 10, subscriberId: 30, readingValue: "115", captureMethod: "manual", clientOperationId: "33333333-3333-4333-8333-333333333333", notes: "قراءة دورية" }))
      .resolves.toEqual({ id: 61, consumptionKwh: 15, status: "pending_review", replayed: false });
    expect(state.rpcCalls).toEqual([expect.objectContaining({ name: "powerhub_create_reading", args: expect.objectContaining({ p_tenant_id: 20, p_subscriber_id: 30, p_reading_value: "115", p_can_override_same_day: false }) })]);
  });

  it("يعدّل ويحذف القراءة المعلقة بدوال Supabase الذرية من دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.readings.updatePending({ siteId: 10, readingId: 60, baseVersion: 1, readingValue: "110", readingAt: new Date("2026-08-03T00:00:00.000Z"), notes: "تصحيح" }))
      .resolves.toEqual({ success: true, consumptionKwh: 20 });
    await expect(caller.readings.deletePending({ siteId: 10, readingId: 60, baseVersion: 2 })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toEqual([
      expect.objectContaining({ name: "powerhub_update_pending_reading", args: expect.objectContaining({ p_tenant_id: 20, p_reading_id: 60, p_base_version: 1 }) }),
      expect.objectContaining({ name: "powerhub_delete_pending_reading", args: expect.objectContaining({ p_tenant_id: 20, p_reading_id: 60, p_base_version: 2 }) }),
    ]);
  });

  it("يعتمد القراءة ويصدر فاتورتها عبر Supabase من دون MySQL أو عامل إرسال", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.readings.approve({ siteId: 10, readingId: 60, baseVersion: 1, sendNow: false })).resolves.toEqual({ success: true });
    await expect(caller.invoices.createFromReading({ siteId: 10, readingId: 60, tariffId: 40, billingPeriod: "2026-08", dueDate: new Date("2026-08-16T00:00:00.000Z"), discountAmount: 0, clientOperationId: "44444444-4444-4444-8444-444444444444" }))
      .resolves.toEqual({ id: 71, invoiceNo: "PH-MAIN-202608-00002", totalAmount: 150 });
    expect(state.rpcCalls).toEqual([
      expect.objectContaining({ name: "powerhub_approve_reading", args: expect.objectContaining({ p_tenant_id: 20, p_reading_id: 60, p_base_version: 1 }) }),
      expect.objectContaining({ name: "powerhub_issue_invoice_from_reading", args: expect.objectContaining({ p_tenant_id: 20, p_reading_id: 60, p_tariff_id: 40, p_billing_period: "2026-08" }) }),
    ]);
    expect(state.inserts.some((entry) => entry.table === "notification_messages")).toBe(false);
  });

  it("يسجل التحصيل الذري عبر Supabase من دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.payments.create({ siteId: 10, subscriberId: 30, invoiceId: 70, paymentNo: "PAY-202608-0001", amount: 25, paymentMethod: "cash", companyAccountId: 90, clientOperationId: "55555555-5555-4555-8555-555555555555" }))
      .resolves.toEqual({ id: 81 });
    expect(state.rpcCalls).toEqual([
      expect.objectContaining({ name: "powerhub_create_payment", args: expect.objectContaining({ p_tenant_id: 20, p_subscriber_id: 30, p_invoice_id: 70, p_company_account_id: 90, p_amount: 25 }) }),
    ]);
  });

  it("يسجل المصروف عبر Supabase مع حارس الفترة المالية", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.expenses.create({ siteId: 10, category: "fuel", description: "وقود التشغيل", amount: 50, referenceNo: "EXP-1" })).resolves.toEqual({ id: 82 });
    expect(state.rpcCalls).toEqual([expect.objectContaining({ name: "powerhub_create_expense", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_category: "fuel", p_amount: 50 }) })]);
  });

  it("ينشئ تسوية مالية بالدالة الذرية في Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.settlements.create({ siteId: 10, periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-08-31T23:59:59.999Z", totalCollected: 100, totalExpenses: 20, actualCash: 75, notes: "تسوية دورية" })).resolves.toEqual({ id: 97 });
    expect(state.rpcCalls).toEqual([expect.objectContaining({ name: "powerhub_create_financial_settlement", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_total_collected: 100, p_total_expenses: 20, p_actual_cash: 75 }) })]);
  });

  it("يغيّر حالة التسوية بالدالة الذرية في Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.settlements.setStatus({ siteId: 10, settlementId: 97, status: "approved" })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toEqual([expect.objectContaining({ name: "powerhub_set_financial_settlement_status", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_settlement_id: 97, p_status: "approved" }) })]);
  });

  it("يعرض قائمة التسويات من Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.settlements.list({ siteId: 10, branchId: 10 })).resolves.toMatchObject([{ id: 97, siteId: 10, totalCollected: "100", totalExpenses: "20", bookProfit: "80", status: "draft" }]);
  });

  it("ينفذ التصحيح الاستثنائي المقفل عبر Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.settlements.exceptionalEdit({ siteId: 10, entityType: "expense", entityId: 82, reason: "تصحيح مرجعي موثق للمصروف", changes: { description: "وصف مصحح" } })).resolves.toMatchObject({ success: true, before: { description: "وصف سابق" }, after: { description: "وصف مصحح" } });
    expect(state.rpcCalls).toEqual([expect.objectContaining({ name: "powerhub_exceptional_locked_edit", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_entity_type: "expense", p_entity_id: 82 }) })]);
  });

  it("ينشئ حساب الشركة وحركاته وتحويله عبر Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.companyAccounts.create({ siteId: 10, name: "جوال بي 1", accountType: "jawwal_pay", phoneNumber: "+970595123456", openingBalance: 5, siteIds: [10] })).resolves.toEqual({ id: 92 });
    await expect(caller.companyAccounts.addMovement({ siteId: 10, accountId: 90, transactionType: "deposit", amount: 10, description: "إيداع" })).resolves.toEqual({ id: 93 });
    await expect(caller.companyAccounts.transfer({ siteId: 10, fromAccountId: 90, toAccountId: 92, amount: 5, description: "تحويل داخلي" })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toEqual([
      expect.objectContaining({ name: "powerhub_create_company_account", args: expect.objectContaining({ p_tenant_id: 20, p_site_ids: [10] }) }),
      expect.objectContaining({ name: "powerhub_add_account_movement", args: expect.objectContaining({ p_account_id: 90, p_transaction_type: "deposit", p_amount: 10 }) }),
      expect.objectContaining({ name: "powerhub_transfer_company_accounts", args: expect.objectContaining({ p_from_account_id: 90, p_to_account_id: 92, p_amount: 5 }) }),
    ]);
  });

  it("يحدّث إعدادات حساب الشركة عبر Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.companyAccounts.updatePhone({ siteId: 10, accountId: 92, phoneNumber: "+970599000001" })).resolves.toEqual({ success: true });
    await expect(caller.companyAccounts.updateOpeningBalance({ siteId: 10, accountId: 92, openingBalance: 100 })).resolves.toEqual({ success: true });
    await expect(caller.companyAccounts.updateSites({ siteId: 10, accountId: 92, siteIds: [10] })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "powerhub_update_company_account_phone", args: expect.objectContaining({ p_tenant_id: 20, p_account_id: 92 }) }),
      expect.objectContaining({ name: "powerhub_update_company_account_opening_balance", args: expect.objectContaining({ p_opening_balance: 100 }) }),
      expect.objectContaining({ name: "powerhub_update_company_account_sites", args: expect.objectContaining({ p_site_ids: [10] }) }),
    ]));
  });

  it("يعرض ويغلق جلسة التحصيل عبر Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.collectorSessions.list({ siteId: 10 })).resolves.toMatchObject([{ session: { id: 96, openedAt: expect.any(Date) }, collector: { id: 1 } }]);
    await expect(caller.collectorSessions.close({ siteId: 10, sessionId: 96, declaredCash: 10 })).resolves.toEqual({ expectedCash: 10, varianceAmount: 0 });
    expect(state.rpcCalls).toEqual([expect.objectContaining({ name: "powerhub_close_collector_session", args: expect.objectContaining({ p_session_id: 96, p_allow_foreign_close: true }) })]);
  });
});
