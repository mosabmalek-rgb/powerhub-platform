import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";
import { SignJWT } from "jose";
import { consumeHttpRateLimit } from "./http-rate-limit";

const state = vi.hoisted(() => {
  const store: any = {
    queries: [] as Array<{ table: string; filters: unknown[][]; selected: string | null; operation: string; payload?: unknown }>,
    rpc: vi.fn(),
    resolve: vi.fn(),
    distributionEnabled: false,
  };

  store.from = vi.fn((table: string) => {
    const query = { table, filters: [] as unknown[][], selected: null as string | null, operation: "select" as string, payload: undefined as unknown };
    store.queries.push(query);
    const chain: Record<string, any> = {};
    chain.select = (columns = "*") => { query.selected = String(columns); return chain; };
    chain.update = (payload: unknown) => { query.operation = "update"; query.payload = payload; return chain; };
    for (const method of ["eq", "neq", "in", "gte", "lte", "gt", "is", "or", "order", "limit"]) {
      chain[method] = (...args: unknown[]) => { query.filters.push([method, ...args]); return chain; };
    }
    chain.range = (...args: unknown[]) => {
      query.filters.push(["range", ...args]);
      return Promise.resolve(store.resolve(table, query, "range"));
    };
    chain.maybeSingle = () => Promise.resolve(store.resolve(table, query, "maybeSingle"));
    chain.then = (onFulfilled: (value: unknown) => unknown, onRejected: (error: unknown) => unknown) =>
      Promise.resolve(store.resolve(table, query, "await")).then(onFulfilled, onRejected);
    return chain;
  });

  return store;
});

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({ from: state.from, rpc: state.rpc }),
}));

vi.mock("./http-rate-limit", () => ({
  consumeHttpRateLimit: vi.fn().mockResolvedValue(true),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

import { registerMobileApi } from "./mobile-api";

type RouteHandler = (req: Request, res: Response, next?: (error?: unknown) => void) => Promise<unknown> | unknown;

const JWT_SECRET = "mobile-api-route-test-secret-at-least-32-characters";
const originalJwtSecret = process.env.JWT_SECRET;

async function accessToken() {
  return new SignJWT({ tenantId: 20, sessionId: 101, tokenUse: "mobile_access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("7")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function responseRecorder() {
  const response: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  response.status = (statusCode: number) => { response.statusCode = statusCode; return response; };
  response.json = (body: unknown) => { response.body = body; return response; };
  response.send = (body?: unknown) => { response.body = body; return response; };
  response.setHeader = (name: string, value: string) => { response.headers[name] = value; return response; };
  return response;
}

describe("Mobile API subscribers route", () => {
  let subscribersHandler: RouteHandler;

  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    state.queries.length = 0;
    state.distributionEnabled = false;
    vi.mocked(consumeHttpRateLimit).mockReset().mockResolvedValue(true);
    state.from.mockClear();
    state.rpc.mockReset().mockResolvedValue({
      data: [{
        cycle_key: "cycle-2026-11",
        cycle_start_at: "2026-11-01T00:00:00.000Z",
        cycle_end_at: "2026-12-01T00:00:00.000Z",
        cycle_label: "دورة نوفمبر",
      }],
      error: null,
    });

    state.resolve.mockReset().mockImplementation(async (table: string, query: any, terminal: string) => {
      if (table === "users") return { data: { id: 7, name: "فني اختبار", account_status: "active", must_change_password: false }, error: null };
      if (table === "tenant_members") return { data: { id: 1, expires_at: null }, error: null };
      if (table === "tenants") return { data: { id: 20, status: "active" }, error: null };
      if (table === "staff_profiles") {
        return { data: [{ site_id: 12, role: "technician", permissions: ["recordReadings", "accessFieldApp"], suspension_started_at: null, suspension_ends_at: null }], error: null };
      }
      if (table === "sites") return { data: [{ id: 12 }], error: null };
      if (table === "tenant_subscriptions") return { data: { status: "active", ends_at: "2099-12-31T00:00:00.000Z" }, error: null };
      if (table === "mobile_api_sessions") return { data: { id: 101 }, error: null };
      if (table === "field_reading_distribution_settings") return { data: state.distributionEnabled ? { is_enabled: true } : null, error: null };
      if (table === "subscribers" && terminal === "range") {
        let data = [
          { id: 201, subscriber_no: "SUB-201", full_name: "مشترك أول", phone: "0590000001", address: "عنوان أول", site_id: 12, assigned_reader_user_id: 7 },
          { id: 202, subscriber_no: "SUB-202", full_name: "مشترك ثان", phone: "0590000002", address: "عنوان ثان", site_id: 12, assigned_reader_user_id: 8 },
        ];
        const readerFilter = query.filters.find((filter: unknown[]) => filter[0] === "eq" && filter[1] === "assigned_reader_user_id");
        if (readerFilter) data = data.filter((row) => row.assigned_reader_user_id === Number(readerFilter[2]));
        return { data, error: null };
      }
      if (table === "meter_readings") {
        const cycleQuery = query.filters.some((filter: unknown[]) => filter[0] === "in" && filter[1] === "subscriber_id");
        if (cycleQuery) {
          return {
            data: [{
              id: 601,
              subscriber_id: 201,
              reading_value: "1250.500",
              reading_at: "2026-11-02T08:30:00.000Z",
              status: "pending_review",
            }],
            error: null,
          };
        }
        if (query.selected === "reading_value") {
          const subscriberFilter = query.filters.find((filter: unknown[]) => filter[0] === "eq" && filter[1] === "subscriber_id");
          return { data: { reading_value: Number(subscriberFilter?.[2]) === 201 ? "1200.500" : "900.00" }, error: null };
        }
        if (query.selected === "reading_at") {
          const subscriberFilter = query.filters.find((filter: unknown[]) => filter[0] === "eq" && filter[1] === "subscriber_id");
          return { data: { reading_at: Number(subscriberFilter?.[2]) === 201 ? "2026-10-20T07:00:00.000Z" : null }, error: null };
        }
      }
      return { data: null, error: null };
    });

    const routes = new Map<string, RouteHandler>();
    const routeMiddlewares = new Map<string, RouteHandler[]>();
    const app = {
      get: (path: string, ...handlers: RouteHandler[]) => {
        routes.set(path, handlers[handlers.length - 1]);
        routeMiddlewares.set(path, handlers.slice(0, -1));
      },
      post: (_path: string, ..._handlers: RouteHandler[]) => undefined,
    };
    registerMobileApi(app as unknown as Express);
    const handler = routes.get("/api/mobile/v1/subscribers");
    if (!handler) throw new Error("Mobile subscribers route was not registered");
    subscribersHandler = async (req, res) => {
      for (const middleware of routeMiddlewares.get("/api/mobile/v1/subscribers") ?? []) {
        let nextCalled = false;
        await middleware(req, res, () => { nextCalled = true; });
        if (!nextCalled) return;
      }
      await handler(req, res);
    };
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  async function callRoute(query: Record<string, string>, token?: string) {
    const req = {
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
      headers: token ? { authorization: `Bearer ${token}` } : {},
      query,
    } as unknown as Request;
    const res = responseRecorder();
    await subscribersHandler(req, res as unknown as Response);
    return res;
  }

  it("rejects an absent or invalid mobile session before querying subscriber data", async () => {
    const res = await callRoute({ branchId: "12" });
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
    expect(state.queries.some((query) => query.table === "subscribers")).toBe(false);
  });

  it("denies a branch outside the authenticated technician scope before reading subscribers", async () => {
    const res = await callRoute({ branchId: "13" }, await accessToken());
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("BRANCH_ACCESS_DENIED");
    expect(state.queries.some((query) => query.table === "subscribers")).toBe(false);
    const membershipQuery = state.queries.find((query) => query.table === "tenant_members");
    expect(membershipQuery?.filters).toContainEqual(["or", expect.stringMatching(/^expires_at\.is\.null,expires_at\.gt\..+$/)]);
  });

  it("returns server-derived cycle state and precision-safe readings only for the requested tenant and branch", async () => {
    const res = await callRoute({ branchId: "12", cursor: "0", limit: "2" }, await accessToken());

    expect(res.statusCode).toBe(200);
    expect(res.body.currentCycle).toMatchObject({
      key: "cycle-2026-11",
      startAt: "2026-11-01T00:00:00.000Z",
      endAt: "2026-12-01T00:00:00.000Z",
      label: "دورة نوفمبر",
    });
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({
      id: 201,
      hasReadingInCurrentCycle: true,
      currentCycleReading: {
        readingId: 601,
        readingValue: "1250.500",
        readingAt: "2026-11-02T08:30:00.000Z",
        status: "pending_review",
      },
    });
    expect(typeof res.body.items[0].currentCycleReading.readingValue).toBe("string");
    expect(res.body.items[1]).toMatchObject({ id: 202, hasReadingInCurrentCycle: false, currentCycleReading: null });
    expect(res.body.nextCursor).toBe("2");

    const subscriberQuery = state.queries.find((query) => query.table === "subscribers");
    expect(subscriberQuery?.filters).toContainEqual(["eq", "tenant_id", 20]);
    expect(subscriberQuery?.filters).toContainEqual(["eq", "site_id", 12]);

    const cycleQuery = state.queries.find((query) => query.table === "meter_readings" && query.filters.some((filter) => filter[0] === "in"));
    expect(cycleQuery?.filters).toContainEqual(["eq", "tenant_id", 20]);
    expect(cycleQuery?.filters).toContainEqual(["in", "subscriber_id", [201, 202]]);
    expect(cycleQuery?.filters).toContainEqual(["eq", "is_opening_baseline", false]);
    expect(cycleQuery?.filters).toContainEqual(["neq", "status", "rejected"]);
    expect(cycleQuery?.filters).toContainEqual(["gte", "reading_at", res.body.currentCycle.startAt]);
    expect(cycleQuery?.filters).toContainEqual(["lte", "reading_at", res.body.currentCycle.endAt]);
    expect(state.rpc).toHaveBeenCalledWith("powerhub_cycle_for_reading", {
      p_tenant_id: 20,
      p_site_id: 12,
      p_reading_at: expect.any(String),
    });
  });

  it("filters the subscriber list by the authenticated reader only when optional distribution is enabled", async () => {
    state.distributionEnabled = true;
    const res = await callRoute({ branchId: "12", cursor: "0", limit: "2" }, await accessToken());
    expect(res.statusCode).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(201);
    const subscriberQuery = state.queries.find((query) => query.table === "subscribers");
    expect(subscriberQuery?.filters).toContainEqual(["eq", "assigned_reader_user_id", 7]);
  });

  it("keeps the full subscriber list when distribution is disabled", async () => {
    const res = await callRoute({ branchId: "12", cursor: "0", limit: "2" }, await accessToken());
    expect(res.statusCode).toBe(200);
    expect(res.body.items).toHaveLength(2);
    const subscriberQuery = state.queries.find((query) => query.table === "subscribers");
    expect(subscriberQuery?.filters.some((filter) => filter[0] === "eq" && filter[1] === "assigned_reader_user_id")).toBe(false);
  });

  it("rate-limits subscriber requests by IP before authentication or database reads", async () => {
    vi.mocked(consumeHttpRateLimit).mockResolvedValueOnce(false);
    const res = await callRoute({ branchId: "12", cursor: "0", limit: "2" }, await accessToken());
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBe("60");
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(consumeHttpRateLimit).toHaveBeenCalledWith(expect.objectContaining({
      scope: "mobile-subscribers-ip",
      windowSeconds: 60,
      maxAttempts: 120,
    }));
    expect(state.queries.some((query) => query.table === "users")).toBe(false);
    expect(state.queries.some((query) => query.table === "subscribers")).toBe(false);
  });

  it("rate-limits subscribers by authenticated session after the IP middleware allows the request", async () => {
    vi.mocked(consumeHttpRateLimit).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const res = await callRoute({ branchId: "12", cursor: "0", limit: "2" }, await accessToken());
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBe("60");
    expect(consumeHttpRateLimit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      scope: "mobile-subscribers-session",
      keyMaterial: "20:7:101",
      windowSeconds: 60,
      maxAttempts: 30,
    }));
    expect(state.queries.some((query) => query.table === "subscribers")).toBe(false);
  });

  it("rejects an invalid query before accessing the subscribers table", async () => {
    const res = await callRoute({ branchId: "not-a-number" }, await accessToken());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("INVALID_QUERY");
    expect(state.queries.some((query) => query.table === "subscribers")).toBe(false);
  });

  it("fails closed when the canonical cycle resolver is unavailable", async () => {
    state.rpc.mockResolvedValueOnce({ data: null, error: { message: "cycle lookup unavailable" } });
    const res = await callRoute({ branchId: "12" }, await accessToken());
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe("DATABASE_UNAVAILABLE");
    expect(state.queries.some((query) => query.table === "meter_readings")).toBe(false);
  });
});
