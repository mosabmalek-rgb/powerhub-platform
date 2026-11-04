import { describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import { SignJWT } from "jose";

const mockState = vi.hoisted(() => {
  const tables: Record<string, Array<Record<string, any>>> = {
    mobile_api_sessions: [{
      id: 11, user_id: 7, tenant_id: 20, revoked_at: null,
      expires_at: "2099-01-01T00:00:00.000Z",
    }],
    users: [{ id: 7, name: "فني اختبار", account_status: "active", must_change_password: false }],
    tenant_members: [{ id: 1, user_id: 7, tenant_id: 20, is_active: true, membership_status: "active" }],
    tenants: [{ id: 20, status: "active" }],
    staff_profiles: [{
      user_id: 7, tenant_id: 20, site_id: 30, is_active: true, role: "technician",
      permissions: ["recordReadings", "accessFieldApp"],
      suspension_started_at: null, suspension_ends_at: null,
    }],
    sites: [{ id: 30, tenant_id: 20, status: "active" }],
    tenant_subscriptions: [{ tenant_id: 20, status: "active", ends_at: "2099-01-01T00:00:00.000Z" }],
    subscribers: [{
      id: 99, tenant_id: 20, site_id: 30, service_status: "active",
      subscriber_no: "SUB-99", full_name: "مشترك اختبار", phone: "0590000099", address: null,
    }],
    meter_readings: [
      {
        id: 900, subscriber_id: 99, reading_value: "120",
        reading_at: "2026-10-10T08:00:00.000Z", status: "approved",
        is_opening_baseline: true,
      },
      {
        id: 901, subscriber_id: 99, reading_value: "126",
        reading_at: "2026-10-15T12:00:00.000Z", status: "pending_review",
        is_opening_baseline: false,
      },
    ],
  };

  const compare = (actual: unknown, operator: string, expected: unknown): boolean => {
    if (operator === "eq") return actual === expected;
    if (operator === "neq") return actual !== expected;
    if (operator === "is") return actual === expected;
    if (operator === "gt" || operator === "gte" || operator === "lt" || operator === "lte") {
      const actualTime = typeof actual === "string" ? Date.parse(actual) : Number.NaN;
      const expectedTime = typeof expected === "string" ? Date.parse(expected) : Number.NaN;
      const left = Number.isFinite(actualTime) ? actualTime : actual as number;
      const right = Number.isFinite(expectedTime) ? expectedTime : expected as number;
      if (operator === "gt") return left > right;
      if (operator === "gte") return left >= right;
      if (operator === "lt") return left < right;
      return left <= right;
    }
    return true;
  };

  const client = {
    from(table: string) {
      const filters: Array<{ column: string; operator: string; value: unknown }> = [];
      const query: any = {
        select: () => query,
        update: () => query,
        insert: () => query,
        eq: (column: string, value: unknown) => { filters.push({ column, operator: "eq", value }); return query; },
        neq: (column: string, value: unknown) => { filters.push({ column, operator: "neq", value }); return query; },
        is: (column: string, value: unknown) => { filters.push({ column, operator: "is", value }); return query; },
        gt: (column: string, value: unknown) => { filters.push({ column, operator: "gt", value }); return query; },
        gte: (column: string, value: unknown) => { filters.push({ column, operator: "gte", value }); return query; },
        lt: (column: string, value: unknown) => { filters.push({ column, operator: "lt", value }); return query; },
        lte: (column: string, value: unknown) => { filters.push({ column, operator: "lte", value }); return query; },
        order: () => query,
        limit: () => query,
        range: () => query,
        matches: () => (tables[table] ?? []).filter((row) =>
          filters.every((filter) => compare(row[filter.column], filter.operator, filter.value))
        ),
        maybeSingle: async () => ({ data: query.matches()[0] ?? null, error: null }),
        single: async () => ({ data: query.matches()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve({ data: query.matches(), error: null }).then(resolve, reject),
      };
      return query;
    },
  };
  return { client, tables };
});

vi.hoisted(() => {
  process.env.JWT_SECRET = "mobile-api-pending-review-cycle-test-secret";
});

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => mockState.client,
}));

import { registerMobileApi } from "./mobile-api";

describe("mobile subscriber cycle status", () => {
  it("returns a pending-review operational reading date while preserving the approved opening baseline value", async () => {
    const handlers = new Map<string, (req: any, res: any) => unknown>();
    const app = {
      get: (path: string, handler: (req: any, res: any) => unknown) => handlers.set(`GET ${path}`, handler),
      post: (path: string, handler: (req: any, res: any) => unknown) => handlers.set(`POST ${path}`, handler),
    } as unknown as Express;
    registerMobileApi(app);

    const token = await new SignJWT({ tenantId: 20, sessionId: 11, tokenUse: "mobile_access" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("7")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode("mobile-api-pending-review-cycle-test-secret"));

    const response = {
      statusCode: 200,
      body: null as any,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { this.body = body; return this; },
      send(body: any) { this.body = body; return this; },
      setHeader() { return this; },
    };
    const handler = handlers.get("GET /api/mobile/v1/subscribers");
    expect(handler).toBeDefined();
    await handler?.({ headers: { authorization: `Bearer ${token}` }, query: { branchId: "30" } }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      id: 99,
      lastReading: "120",
      lastReadingAt: "2026-10-15T12:00:00.000Z",
    });
  });
});
