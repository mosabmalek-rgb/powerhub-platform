import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const site = { id: 10, tenant_id: 20, name: "الفرع الرئيسي", code: "MAIN", city: "غزة", address: null, status: "active", anomaly_alert_percent: 50, invoice_due_days: 14, created_at: "2026-08-01T00:00:00.000Z" };
  const subscriber = { id: 30, tenant_id: 20, site_id: 10, subscriber_no: "MAIN-001", client_operation_id: null, full_name: "مشترك الاختبار", phone: "+970595000000", whatsapp_number: null, address: null, subscription_type: "residential", service_status: "active", created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" };
  const tables: Record<string, unknown[]> = {
    sites: [site], subscribers: [subscriber],
    tariffs: [{ id: 40, tenant_id: 20, site_id: 10, name: "التعرفة الأساسية", code: "BASE", price_per_kwh: 1.25, fixed_fee: 0, tax_rate: 0, is_active: true, effective_from: "2026-08-01T00:00:00.000Z", created_at: "2026-08-01T00:00:00.000Z" }],
    generators: [{ id: 50, tenant_id: 20, site_id: 10, code: "GEN-1", name: "مولد الاختبار", serial_number: null, rated_capacity_kw: 150, fuel_type: "diesel", fuel_level_liters: 0, operating_hours: 0, status: "active", last_maintenance_at: null, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" }],
    meter_readings: [{ id: 60, tenant_id: 20, subscriber_id: 30, client_operation_id: null, reading_at: "2026-08-02T00:00:00.000Z", reading_value: 100, previous_reading_value: 90, consumption_kwh: 10, capture_method: "manual", image_key: null, image_hash: null, status: "pending_review", entered_by_user_id: 1, reviewed_by_user_id: null, reviewed_at: null, notes: null, version_no: 1, created_at: "2026-08-02T00:00:00.000Z", updated_at: "2026-08-02T00:00:00.000Z" }],
    invoices: [{ id: 70, site_id: 10, status: "issued", total_amount: 100, paid_amount: 25, balance_due: 75, consumption_kwh: 10 }],
    expenses: [{ id: 80, site_id: 10, amount: 15 }],
    notification_messages: [{ id: 90, subscriber_id: 30, status: "failed" }],
    users: [{ id: 1, role: "admin" }],
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
      return query;
    },
  };
  return { client, tables };
});

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => state.client }));
vi.mock("./db", () => ({ getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }), syncSupabaseUser: vi.fn() }));

import { powerhubRouter } from "./powerhub";

describe("قوائم التشغيل الأساسية عبر Supabase", () => {
  beforeEach(() => {
    state.tables.users = [{ id: 1, role: "admin" }];
  });

  it("يعرض الفروع والمشتركين والتعرفة والمولدات والقراءات دون استدعاء MySQL", async () => {
    const caller = powerhubRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.sites.list()).resolves.toMatchObject([{ id: 10, tenantId: 20, createdAt: expect.any(Date) }]);
    await expect(caller.subscribers.list({ siteId: 10 })).resolves.toMatchObject([{ id: 30, subscriberNo: "MAIN-001", fullName: "مشترك الاختبار", createdAt: expect.any(Date) }]);
    await expect(caller.tariffs.list({ siteId: 10 })).resolves.toMatchObject([{ id: 40, pricePerKwh: "1.25", effectiveFrom: expect.any(Date) }]);
    await expect(caller.generators.list({ siteId: 10 })).resolves.toMatchObject([{ id: 50, ratedCapacityKw: "150", createdAt: expect.any(Date) }]);
    await expect(caller.readings.list({ siteId: 10 })).resolves.toMatchObject([{ reading: { id: 60, consumptionKwh: "10", readingAt: expect.any(Date) }, subscriber: { id: 30, fullName: "مشترك الاختبار" } }]);
    await expect(caller.dashboard.summary({ siteId: 10 })).resolves.toEqual({ subscribers: 1, generators: { active: 1, maintenance: 0 }, financial: { invoiced: 100, collected: 25, outstanding: 75, expenses: 15, operatingProfit: 10 }, energyKwh: 10, failedNotifications: 1 });
  });

  it("يرفض عرض بيانات الفرع لمستخدم لا يملك عضوية Supabase فعالة", async () => {
    state.tables.users = [{ id: 2, role: "user" }];
    state.tables.tenant_members = [];
    const caller = powerhubRouter.createCaller({ user: { id: 2, role: "user" } as never, req: {} as never, res: {} as never });
    await expect(caller.subscribers.list({ siteId: 10 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
