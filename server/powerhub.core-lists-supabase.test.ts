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
    user_quick_action_preferences: [{ user_id: 1, site_id: 10, action_ids: ["record_reading"], updated_at: "2026-08-01T00:00:00.000Z" }],
    tenant_tweetsms_accounts: [{ tenant_id: 20, sender_name: "PowerHub", monthly_limit: 1000, is_active: true, credential_ciphertext: "configured", last_error: null }],
    sms_package_requests: [],
    payments: [{ id: 81, tenant_id: 20, site_id: 10, subscriber_id: 30, invoice_id: 70, payment_no: "PAY-202608-0001", client_operation_id: null, amount: 25, payment_method: "cash", transfer_from_account: null, transfer_from_type: null, transfer_to_account: null, transfer_to_type: null, reference_no: "REF-1", receipt_image_key: null, receipt_image_hash: null, status: "completed", collected_by_user_id: 1, collector_session_id: null, paid_at: "2026-08-03T00:00:00.000Z", created_at: "2026-08-03T00:00:00.000Z" }],
    company_accounts: [{ id: 90, tenant_id: 20, name: "كاش", account_type: "cash", phone_number: null, color: "#64748b", opening_balance: 100, is_active: true, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" }],
    company_account_sites: [{ account_id: 90, site_id: 10 }],
    account_transactions: [{ id: 91, tenant_id: 20, account_id: 90, transaction_type: "collection", amount: 25, description: "تحصيل الفاتورة PAY-202608-0001", reference_no: "REF-1", related_payment_id: 81, related_account_id: null, created_by_user_id: 1, occurred_at: "2026-08-03T00:00:00.000Z", created_at: "2026-08-03T00:00:00.000Z" }],
    collector_sessions: [{ id: 96, tenant_id: 20, site_id: 10, collector_user_id: 1, status: "open", opening_cash: 5, expected_cash: 5, declared_cash: null, variance_amount: null, opened_at: "2026-08-03T00:00:00.000Z", closed_at: null, notes: null, closed_by_user_id: null, created_at: "2026-08-03T00:00:00.000Z", updated_at: "2026-08-03T00:00:00.000Z" }],
    financial_settlements: [{ id: 97, tenant_id: 20, site_id: 10, period_start: "2026-08-01T00:00:00.000Z", period_end: "2026-08-31T23:59:59.999Z", total_collected: 100, total_expenses: 20, book_profit: 80, actual_cash: 75, difference: -5, notes: "تسوية دورية", status: "draft", created_by_user_id: 1, approved_by_user_id: null, locked_at: null, created_at: "2026-08-31T23:59:59.999Z", updated_at: "2026-08-31T23:59:59.999Z" }],
    audit_logs: [{ id: 108, tenant_id: 20, site_id: 10, user_id: 1, actor_platform_role: "platform_admin", actor_tenant_role: "owner", entity_type: "subscriber", entity_id: "30", action: "create", before_data: null, after_data: { subscriberNo: "MAIN-001" }, metadata: null, created_at: "2026-08-03T00:00:00.000Z" }],
    users: [{ id: 1, role: "admin" }], tenant_members: [{ tenant_id: 20, user_id: 1, role: "owner", is_active: true, membership_status: "active" }], tenant_subscriptions: [{ tenant_id: 20, plan: "professional" }], platform_settings: [{ setting_key: "branch_feature", is_enabled: true, value: { defaultLimit: { starter: 1, professional: 3, enterprise: 10 } } }], tenant_branch_settings: [],
    tenant_owner_profiles: [{ tenant_id: 20, company_name: "شركة المولد", report_logo_key: null }],
    tenants: [{ id: 20, plan: "starter" }],
    subscription_upgrade_requests: [{ id: 109, tenant_id: 20, current_plan: "starter", requested_plan: "professional", status: "pending", note: "مراجعة الباقة", created_at: "2026-08-20T00:00:00.000Z", reviewed_at: null }],
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
        or: (expression: string) => { const match = expression.match(/^site_id\.eq\.(\d+),site_id\.is\.null$/); if (match) { const siteId = Number(match[1]); filteredRows = filteredRows.filter((row) => { const siteValue = (row as Record<string, unknown>).site_id; return siteValue === siteId || siteValue === null; }); } return query; },
        is: () => query,
        neq: (column: string, value: unknown) => { filteredRows = filteredRows.filter((row) => !(column in (row as Record<string, unknown>)) || (row as Record<string, unknown>)[column] !== value); return query; },
        order: () => query,
        gte: () => query,
        lte: () => query,
        lt: () => query,
        not: () => query,
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
        upsert(values: unknown) {
          inserts.push({ table, values });
          return resolved(null);
        },
      };
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      if (name === "powerhub_subscriber_portal_list") return resolved([{ portal_code: "main", display_name: "بوابة الفرع الرئيسي", primary_color: "#0D1117", accent_color: "#F5B800", site_name: "الفرع الرئيسي", city: "غزة" }]);
      if (name === "powerhub_subscriber_portal_theme") return resolved([{ portal_code: "main", display_name: "بوابة الفرع الرئيسي", primary_color: "#0D1117", accent_color: "#F5B800", site_name: "الفرع الرئيسي", city: "غزة" }]);
      if (name === "powerhub_subscriber_portal_lookup") return resolved({
        portal: { portalCode: "main", displayName: "بوابة الفرع الرئيسي", primaryColor: "#0D1117", accentColor: "#F5B800", city: "غزة" },
        subscriber: { subscriberNo: "MAIN-001", fullName: "مشترك الاختبار", phone: "+970595000000", address: null, subscriptionType: "residential", serviceStatus: "active", joinedAt: "2026-08-01T00:00:00.000Z" },
        invoices: [{ invoiceNo: "MAIN-202608-0001", billingPeriod: "2026-08", issueDate: "2026-08-02T00:00:00.000Z", dueDate: "2026-08-16T00:00:00.000Z", consumptionKwh: 10, totalAmount: 100, paidAmount: 25, balanceDue: 75, status: "issued" }],
        payments: [{ id: 81, paymentNo: "PAY-202608-0001", amount: 25, paymentMethod: "cash", status: "completed", paidAt: "2026-08-03T00:00:00.000Z", invoiceNo: "MAIN-202608-0001" }],
      });
      if (name === "powerhub_subscriber_portal_invoice") return resolved({
        portal: { displayName: "بوابة الفرع الرئيسي", primaryColor: "#0D1117", accentColor: "#F5B800" },
        subscriber: { fullName: "مشترك الاختبار", subscriberNo: "MAIN-001", phone: "+970595000000", address: null },
        invoice: { invoiceNo: "MAIN-202608-0001", billingPeriod: "2026-08", issueDate: "2026-08-02T00:00:00.000Z", dueDate: "2026-08-16T00:00:00.000Z", previousReading: 90, currentReading: 100, consumptionKwh: 10, pricePerKwh: 10, fixedFee: 0, taxAmount: 0, discountAmount: 0, totalAmount: 100, paidAmount: 25, balanceDue: 75, status: "issued" },
        lines: [{ description: "استهلاك كهرباء", quantity: 10, unitPrice: 10, amount: 100 }],
      });
      if (name === "powerhub_save_site_portal_settings") return resolved([{ portal_code: "main" }]);
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
      if (name === "powerhub_save_custom_permission_role") return resolved([{ role_id: 122, mutation: "create" }]);
      if (name === "powerhub_delete_custom_permission_role") return resolved([{ role_id: 122 }]);
      if (name === "powerhub_update_staff_profile_permissions") return resolved([{ profile_id: 120, target_user_id: 2 }]);
      if (name === "powerhub_update_staff_profile_status") return resolved([{ profile_id: 120, is_active: true, suspension_ends_at: "2026-08-10T12:00:00.000Z" }]);
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

  it("يعرض بوابة المشترك العامة وفاتورتها عبر دوال Supabase بعد التحقق الثنائي دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: null as never, req: {} as never, res: {} as never });
    await expect(caller.subscriberPortal.list()).resolves.toEqual([{
      portalCode: "main", displayName: "بوابة الفرع الرئيسي", primaryColor: "#0D1117", accentColor: "#F5B800", siteName: "الفرع الرئيسي", city: "غزة",
    }]);
    await expect(caller.subscriberPortal.theme({ portalCode: "main" })).resolves.toMatchObject({ portalCode: "main", displayName: "بوابة الفرع الرئيسي" });
    await expect(caller.subscriberPortal.lookup({ portalCode: "main", subscriberNo: "MAIN-001", phone: "+970595000000" })).resolves.toMatchObject({
      subscriber: { fullName: "مشترك الاختبار", subscriberNo: "MAIN-001" }, summary: { outstandingBalance: 75 }, invoices: [{ invoiceNo: "MAIN-202608-0001" }],
    });
    await expect(caller.subscriberPortal.invoice({ portalCode: "main", subscriberNo: "MAIN-001", phone: "+970595000000", invoiceNo: "MAIN-202608-0001" })).resolves.toMatchObject({
      invoice: { invoiceNo: "MAIN-202608-0001", balanceDue: 75 }, lines: [{ description: "استهلاك كهرباء" }],
    });
    expect(state.rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "powerhub_subscriber_portal_list" }),
      expect.objectContaining({ name: "powerhub_subscriber_portal_theme", args: { p_portal_code: "main" } }),
      expect.objectContaining({ name: "powerhub_subscriber_portal_lookup", args: { p_portal_code: "main", p_subscriber_no: "MAIN-001", p_phone: "+970595000000" } }),
      expect.objectContaining({ name: "powerhub_subscriber_portal_invoice", args: { p_portal_code: "main", p_subscriber_no: "MAIN-001", p_phone: "+970595000000", p_invoice_no: "MAIN-202608-0001" } }),
    ]));
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

  it("يعرض طلب ترقية الباقة الحالي من Supabase ضمن نطاق الفرع دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscription.currentUpgradeRequest({ siteId: 10 })).resolves.toMatchObject({
      id: 109,
      currentPlan: "starter",
      requestedPlan: "professional",
      status: "pending",
      note: "مراجعة الباقة",
      createdAt: expect.any(Date),
      reviewedAt: null,
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

  it("يعرض ملخص لوحة التشغيل والنظرة المالية لجميع الأفرع من Supabase دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.dashboard.allBranchesSummary({ siteId: 10 })).resolves.toEqual({
      branchCount: 1,
      subscribers: 1,
      generators: { active: 1, maintenance: 0 },
      financial: { invoiced: 100, collected: 25, outstanding: 75, expenses: 15, operatingProfit: 10 },
      energyKwh: 10,
      failedNotifications: 1,
    });
    await expect(caller.dashboard.financialOverview({ siteId: 10, scope: "all" })).resolves.toMatchObject({
      branchSummaries: [{ id: 10, name: "الفرع الرئيسي", activeSubscribers: 1 }],
      outstanding: { total: 75, accountCount: 1 },
      topDebtors: [{ subscriberNo: "MAIN-001", invoiceNo: "MAIN-202608-0001" }],
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

  it("يعرض إعدادات البوابة ونسبة التنبيه الشاذ من Supabase ضمن الفرع دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscriberPortal.settings({ siteId: 10 })).resolves.toMatchObject({
      siteId: 10, tenantId: 20, portalCode: "main", displayName: "الفرع الرئيسي", isEnabled: true,
    });
    await expect(caller.sites.anomalyAlert({ siteId: 10 })).resolves.toEqual({ anomalyAlertPercent: 50 });
  });

  it("يحفظ إعدادات بوابة المشترك عبر RPC Supabase ذرية دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscriberPortal.saveSettings({
      siteId: 10, portalCode: "main", displayName: "بوابة الفرع الرئيسي", primaryColor: "#0D1117", accentColor: "#F5B800", isEnabled: true,
    })).resolves.toEqual({ success: true, portalCode: "main" });
    expect(state.rpcCalls).toContainEqual(expect.objectContaining({
      name: "powerhub_save_site_portal_settings",
      args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_portal_code: "main" }),
    }));
  });

  it("يعرض هوية التقارير من Supabase ضمن نطاق المستأجر دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.reportBranding.get({ siteId: 10 })).resolves.toEqual({ companyName: "شركة المولد", reportLogoKey: null, logoUrl: null });
  });

  it("يعرض سجل التدقيق من Supabase ضمن المستأجر والفرع دون MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.audit.list({ siteId: 10 })).resolves.toMatchObject([{
      id: 108, tenantId: 20, siteId: 10, userId: 1, entityType: "subscriber", entityId: "30", action: "create",
    }]);
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

  it("يحفظ قوالب الرسائل في Supabase ويعطّل حفظ الاعتمادات الموروث", async () => {
    state.tables.platform_settings = [{ setting_key: "invoice_delivery_channels", is_enabled: true, value: { smsEnabled: true, whatsappEnabled: true }, message: null }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.messaging.saveInvoiceTemplate({ siteId: 10, channel: "sms", body: "مرحباً {{subscriber_name}}، فاتورتك {{invoice_no}} جاهزة.", isActive: true })).resolves.toEqual({ success: true });
    await expect(caller.messaging.savePaymentReceiptTemplate({ siteId: 10, body: "مرحباً {{subscriber_name}}، تم استلام دفعتك بنجاح.", isActive: true })).resolves.toEqual({ success: true });
    expect(state.inserts).toContainEqual({ table: "tenant_invoice_message_templates", values: expect.objectContaining({ tenant_id: 20, channel: "sms", event_type: "invoice_issued", is_active: true }) });
    expect(state.inserts).toContainEqual({ table: "tenant_payment_receipt_message_templates", values: expect.objectContaining({ tenant_id: 20, channel: "sms", is_active: true }) });
    await expect(caller.messaging.saveConfiguration({ siteId: 10, channel: "sms", provider: "tweetsms", credential: "credential-long-enough", isActive: true })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("يعرض سجل الإشعارات من Supabase ويعطّل كل الإرسال وإعادة المحاولة الموروثة", async () => {
    state.tables.notification_messages = [{ id: 99, tenant_id: 20, invoice_id: 70, subscriber_id: 30, channel: "sms", event_type: "invoice_issued", recipient: "+970595000000", status: "failed", provider_message_id: null, payload: { invoiceNo: "MAIN-202608-0001" }, attempts: 1, last_error: "غير مهيأ", created_at: "2026-08-25T00:00:00.000Z", updated_at: "2026-08-25T00:00:00.000Z" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.notifications.list({ siteId: 10, eventType: "invoice_issued" })).resolves.toMatchObject([{ notification: { id: 99, status: "failed", createdAt: expect.any(Date) }, subscriber: { id: 30, fullName: "مشترك الاختبار" }, invoiceNo: "MAIN-202608-0001" }]);
    await expect(caller.notifications.retry({ siteId: 10, notificationId: 99 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.notifications.retryFailedInvoiceNotification({ siteId: 10, notificationId: 99 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.notifications.retryFailedInvoiceNotifications({ siteId: 10, notificationIds: [99] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.notifications.retryPaymentReceipt({ siteId: 10, notificationId: 99 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.notifications.sendDeferredInvoices({ siteId: 10, limit: 1 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.notifications.sendBulkInvoiceSms({ siteId: 10, invoiceIds: [70] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.notifications.sendPaymentReminder({ siteId: 10, invoiceId: 70 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.notifications.sendPaymentReceipt({ siteId: 10, paymentId: 81, channel: "sms" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("يعرض سجل عمليات الإرسال الجماعي وتفاصيله من Supabase دون MySQL", async () => {
    state.tables.users = [{ id: 1, role: "admin", name: "مالك الاختبار", email: "owner@example.com" }];
    state.tables.audit_logs = [{ id: 109, tenant_id: 20, site_id: 10, user_id: 1, entity_type: "notification_batch", entity_id: "99", action: "send_deferred_invoice_notifications", metadata: { notificationIds: [99], requested: 1, submitted: 0, failed: 1 }, created_at: "2026-08-25T00:00:00.000Z" }];
    state.tables.notification_messages = [{ id: 99, tenant_id: 20, invoice_id: 70, subscriber_id: 30, channel: "sms", event_type: "invoice_issued", recipient: "+970595000000", status: "failed", provider_message_id: null, payload: {}, attempts: 1, last_error: "غير مهيأ", created_at: "2026-08-25T00:00:00.000Z", updated_at: "2026-08-25T00:00:00.000Z" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.notifications.listBulkInvoiceSends({ siteId: 10 })).resolves.toMatchObject([{ id: 109, action: "send_deferred_invoice_notifications", executorId: 1, executorName: "مالك الاختبار", createdAt: expect.any(Date) }]);
    await expect(caller.notifications.bulkInvoiceSendDetails({ siteId: 10, auditLogId: 109 })).resolves.toMatchObject({ operation: { id: 109, createdAt: expect.any(Date) }, items: [{ notificationId: 99, invoiceId: 70, invoiceNo: "MAIN-202608-0001", subscriberName: "مشترك الاختبار", status: "failed" }] });
  });

  it("يقرأ ويحفظ تفضيلات الإجراءات السريعة عبر Supabase دون MySQL", async () => {
    state.tables.user_quick_action_preferences = [{ user_id: 1, site_id: 10, action_ids: ["record_reading"], updated_at: "2026-08-01T00:00:00.000Z" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.quickActions.preferences({ siteId: 10 })).resolves.toEqual({ actionIds: ["record_reading"], updatedAt: expect.any(Date) });
    await expect(caller.quickActions.savePreferences({ siteId: 10, actionIds: ["record_reading", "collect_payment"] })).resolves.toEqual({ success: true, actionIds: ["record_reading", "collect_payment"] });
    expect(state.inserts).toContainEqual({ table: "user_quick_action_preferences", values: { user_id: 1, site_id: 10, action_ids: ["record_reading", "collect_payment"] } });
    expect(state.inserts).toContainEqual(expect.objectContaining({ table: "audit_logs" }));
  });

  it("يقرأ وصول الموظف وامتداد الفروع وسجل تغييرات الصلاحيات من Supabase دون MySQL", async () => {
    state.tables.users = [{ id: 2, role: "user" }];
    state.tables.tenant_members = [{ tenant_id: 20, user_id: 2, role: "member", is_active: true, membership_status: "active" }];
    state.tables.staff_profiles = [{ id: 120, tenant_id: 20, user_id: 2, site_id: null, role: "manager", permissions: ["manageSubscribers"], custom_role_id: null, suspension_started_at: null, suspension_ends_at: null, is_active: true }];
    const staffCaller = powerhubRouter.createCaller({ user: { id: 2, role: "user" } as never, req: {} as never, res: {} as never });
    await expect(staffCaller.staff.myAccess({ siteId: 10 })).resolves.toEqual({ role: "manager", permissions: ["manageSubscribers"], tenantId: 20 });
    await expect(staffCaller.staff.allBranchAccess({ siteId: 10 })).resolves.toEqual({ isGlobal: true });
    state.tables.users = [{ id: 1, role: "admin" }];
    state.tables.audit_logs = [{ id: 121, tenant_id: 20, site_id: 10, user_id: 2, entity_type: "staff_profile", entity_id: "120", action: "update_permissions", after_data: { permissions: ["manageSubscribers"] }, metadata: { targetUserId: 2 }, created_at: "2026-08-26T00:00:00.000Z" }];
    const ownerCaller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(ownerCaller.staff.permissionChanges({ siteId: 10, userId: 2 })).resolves.toMatchObject([{ id: 121, userId: 2, action: "update_permissions", createdAt: expect.any(Date), afterData: { permissions: ["manageSubscribers"] } }]);
  });

  it("يعرض كتالوج الصلاحيات والأدوار المخصصة النشطة من Supabase دون MySQL", async () => {
    state.tables.users = [{ id: 1, role: "admin" }];
    state.tables.custom_permission_roles = [{ id: 122, tenant_id: 20, name: "دور التحصيل", description: "صلاحيات تحصيل", permissions: ["collectPayments"], is_active: true }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.permissionCatalog({ siteId: 10 })).resolves.toContain("manageTeam");
    await expect(caller.staff.customRoles({ siteId: 10 })).resolves.toEqual([{ id: 122, name: "دور التحصيل", description: "صلاحيات تحصيل", permissions: ["collectPayments"], isActive: true }]);
  });

  it("يحفظ ويحذف الدور المخصص بمعاملات Supabase الذرية دون MySQL", async () => {
    state.tables.users = [{ id: 1, role: "admin" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.saveCustomRole({ siteId: 10, name: "دور التحصيل", description: "صلاحيات تحصيل", permissions: ["collectPayments"] })).resolves.toEqual({ success: true, id: 122 });
    await expect(caller.staff.deleteCustomRole({ siteId: 10, roleId: 122 })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toEqual(expect.arrayContaining([
      { name: "powerhub_save_custom_permission_role", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_role_id: null, p_permissions: ["collectPayments"] }) },
      { name: "powerhub_delete_custom_permission_role", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_user_id: 1, p_role_id: 122 }) },
    ]));
  });

  it("يعدّل صلاحيات الحساب الفرعي عبر معاملة Supabase الذرية دون MySQL", async () => {
    state.tables.users = [{ id: 1, role: "admin" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.updatePermissions({ siteId: 10, profileId: 120, customRoleId: 122, permissions: ["collectPayments"] })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toContainEqual({ name: "powerhub_update_staff_profile_permissions", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_actor_user_id: 1, p_profile_id: 120, p_custom_role_id: 122, p_permissions: ["collectPayments"] }) });
  });

  it("يوقف الحساب الفرعي ويرفع التوقيف ويحدث حالته عبر Supabase دون MySQL", async () => {
    state.tables.users = [{ id: 1, role: "admin" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.suspend({ siteId: 10, profileId: 120, startsAt: "2026-08-10T10:00:00.000Z", endsAt: "2026-08-10T12:00:00.000Z" })).resolves.toMatchObject({ success: true, suspensionEndsAt: expect.any(Date) });
    await expect(caller.staff.clearSuspension({ siteId: 10, profileId: 120 })).resolves.toEqual({ success: true });
    await expect(caller.staff.setActive({ siteId: 10, profileId: 120, isActive: false })).resolves.toEqual({ success: true, isActive: false });
    expect(state.rpcCalls).toEqual(expect.arrayContaining([
      { name: "powerhub_update_staff_profile_status", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_actor_user_id: 1, p_profile_id: 120, p_operation: "suspend" }) },
      { name: "powerhub_update_staff_profile_status", args: expect.objectContaining({ p_profile_id: 120, p_operation: "clear_suspension" }) },
      { name: "powerhub_update_staff_profile_status", args: expect.objectContaining({ p_profile_id: 120, p_operation: "set_active", p_is_active: false }) },
    ]));
  });

  it("يعرض سجل نشاط الحساب الفرعي من Supabase دون MySQL", async () => {
    state.tables.users = [{ id: 1, role: "admin" }];
    state.tables.audit_logs = [{ id: 125, tenant_id: 20, site_id: 10, user_id: 2, entity_type: "staff_profile", action: "update_permissions", metadata: { source: "team" }, after_data: { permissions: ["collectPayments"] }, created_at: "2026-08-10T12:00:00.000Z" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.activity({ siteId: 10, userId: 2 })).resolves.toMatchObject([{ id: 125, action: "update_permissions", entityType: "staff_profile", createdAt: expect.any(Date), metadata: { source: "team" } }]);
  });

  it("يعرض قائمة الحسابات ودليل التعيين من Supabase ضمن المستأجر والفرع فقط دون MySQL", async () => {
    state.tables.users = [
      { id: 1, role: "admin", name: "مدير المنصة", email: "admin@example.com", auth_user_id: "00000000-0000-4000-8000-000000000001", login_method: "supabase", account_status: "active", must_change_password: false, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z", last_signed_in: "2026-08-05T00:00:00.000Z" },
      { id: 2, role: "user", name: "محاسب الفرع", email: "accountant@example.com", auth_user_id: "00000000-0000-4000-8000-000000000002", login_method: "supabase", account_status: "active", must_change_password: false, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z", last_signed_in: "2026-08-04T00:00:00.000Z" },
      { id: 3, role: "user", name: "موظف مستأجر آخر", email: "outside@example.com", auth_user_id: "00000000-0000-4000-8000-000000000003", login_method: "supabase", account_status: "active", must_change_password: false, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z", last_signed_in: "2026-08-06T00:00:00.000Z" },
    ];
    state.tables.tenant_members = [
      { tenant_id: 20, user_id: 2, role: "member", is_active: true, membership_status: "active" },
      { tenant_id: 99, user_id: 3, role: "member", is_active: true, membership_status: "active" },
    ];
    state.tables.staff_profiles = [
      { id: 126, tenant_id: 20, user_id: 2, site_id: 10, role: "accountant", custom_role_id: null, permissions: ["collectPayments"], suspension_started_at: null, suspension_ends_at: null, is_active: true, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" },
      { id: 127, tenant_id: 20, user_id: 3, site_id: 11, role: "collector", custom_role_id: null, permissions: [], suspension_started_at: null, suspension_ends_at: null, is_active: true, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" },
    ];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.list({ siteId: 10 })).resolves.toMatchObject([{ profile: { id: 126, tenantId: 20, siteId: 10, role: "accountant", createdAt: expect.any(Date) }, user: { id: 2, name: "محاسب الفرع", email: "accountant@example.com" } }]);
    await expect(caller.staff.directory({ siteId: 10 })).resolves.toEqual([{ id: 2, name: "محاسب الفرع", email: "accountant@example.com", role: "user" }]);
  });

  it("يقرأ سياسة أدوار وحدود الحسابات الفرعية من Supabase مع تجاوز المستأجر والعدد النشط", async () => {
    state.tables.users = [{ id: 1, role: "admin" }];
    state.tables.tenant_subscriptions = [{ tenant_id: 20, plan: "professional" }];
    state.tables.tenants = [{ id: 20, plan: "starter" }];
    state.tables.platform_settings = [
      { setting_key: "owner_subaccount_roles", is_enabled: true, value: { allowedRoles: ["accountant", "viewer", "owner"] } },
      { setting_key: "owner_subaccount_limits", is_enabled: true, value: { limits: { professional: 5 } } },
      { setting_key: "owner_limit_overrides", is_enabled: true, value: { overrides: { "20": { subaccountLimit: 3, allowedRoles: ["accountant"] } } } },
    ];
    state.tables.tenant_members = [
      { tenant_id: 20, user_id: 2, role: "member", is_active: true, membership_status: "active" },
      { tenant_id: 20, user_id: 3, role: "member", is_active: true, membership_status: "active" },
      { tenant_id: 20, user_id: 4, role: "member", is_active: false, membership_status: "active" },
      { tenant_id: 99, user_id: 5, role: "member", is_active: true, membership_status: "active" },
    ];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.allowedSubaccountRoles({ siteId: 10 })).resolves.toEqual({ roles: ["accountant"], limit: 3, currentCount: 2, remaining: 1 });
  });

  it("يعيّن حساباً موجوداً عبر معاملة Supabase الذرية دون MySQL", async () => {
    state.tables.users = [{ id: 1, role: "admin" }];
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.assign({ siteId: 10, userId: 2, role: "accountant", allBranches: true })).resolves.toEqual({ success: true });
    expect(state.rpcCalls).toContainEqual({ name: "powerhub_assign_existing_staff", args: expect.objectContaining({ p_tenant_id: 20, p_site_id: 10, p_actor_user_id: 1, p_target_user_id: 2, p_role: "accountant", p_all_branches: true }) });
  });

  it("يعطّل إعادة تعيين كلمة المرور انتقالياً قبل أي استدعاء MySQL أو Supabase Auth", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.resetPassword({ siteId: 10, profileId: 70 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("يعطّل إنشاء الحساب الفرعي انتقالياً قبل أي استدعاء MySQL أو Supabase Auth", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.staff.create({ siteId: 10, name: "محاسب تجريبي", email: "accountant@example.com", temporaryPassword: "StrongPass1!", role: "accountant", allBranches: false })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
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
