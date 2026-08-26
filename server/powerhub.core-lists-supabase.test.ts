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
    expenses: [{ id: 80, site_id: 10, amount: 15 }],
    notification_messages: [{ id: 90, subscriber_id: 30, status: "failed" }],
    users: [{ id: 1, role: "admin" }],
    tenants: [{ id: 20, plan: "starter" }],
  };
  const resolved = (data: unknown) => Promise.resolve({ data, error: null });
  const client = {
    from(table: string) {
      const rows = tables[table] ?? [];
      const query = {
        select: () => query,
        eq: () => query,
        in: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: () => resolved(rows[0] ?? null),
        then: <TResult1 = { data: unknown[]; error: null }, TResult2 = never>(
          onfulfilled?: ((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) => resolved(rows).then(onfulfilled, onrejected),
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
    await expect(caller.dashboard.summary({ siteId: 10 })).resolves.toEqual({ subscribers: 1, generators: { active: 1, maintenance: 0 }, financial: { invoiced: 100, collected: 25, outstanding: 75, expenses: 15, operatingProfit: 10 }, energyKwh: 10, failedNotifications: 1 });
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
});
