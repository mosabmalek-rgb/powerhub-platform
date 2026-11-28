import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { NextFunction, Request, Response } from "express";
import {
  b5TraceMiddleware, getB5TraceRoute, measureB5Stage,
} from "./b5-request-trace";

const preview = { VERCEL_ENV: "preview" } as NodeJS.ProcessEnv;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("B5.22 privacy-safe correlated read tracing", () => {
  it("enables exactly three GET report routes only in Preview", () => {
    for (const route of [
      "financialGLSubledgerReconciliation",
      "financialGLCompanyMovementAudit",
      "financialGLSiteStatements",
    ]) {
      expect(getB5TraceRoute(
        `/api/trpc/powerhub.reports.${route}?input=%7B%22private%22%3A1%7D`, "GET", preview,
      )).toBe(route);
    }
    expect(getB5TraceRoute(
      "/api/trpc/powerhub.reports.financialGLSiteStatements", "GET", { VERCEL_ENV: "production" },
    )).toBeNull();
    expect(getB5TraceRoute(
      "/api/trpc/powerhub.reports.financialGLSiteStatements", "POST", preview,
    )).toBeNull();
    expect(getB5TraceRoute(
      "/api/trpc/powerhub.reports.financialGLSiteStatements,powerhub.auth.me", "GET", preview,
    )).toBeNull();
    expect(getB5TraceRoute(
      "/api/trpc/powerhub.reports.financialGLSiteStatements/other", "GET", preview,
    )).toBeNull();
  });

  it("records one bounded summary even when connection closes after finish", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_REGION", "sin1");
    const entries: unknown[][] = [];
    vi.spyOn(console, "info").mockImplementation((...args) => { entries.push(args); });
    const emitter = new EventEmitter();
    const headers = new Map<string, string>();
    const res = Object.assign(emitter, {
      statusCode: 200,
      setHeader(name: string, value: string) { headers.set(name, value); return this; },
    }) as unknown as Response;
    const req = {
      method: "GET",
      originalUrl: "/api/trpc/powerhub.reports.financialGLSiteStatements?input=PRIVATE_INPUT",
    } as Request;
    let completed: Promise<void> | undefined;
    const next: NextFunction = (() => {
      completed = (async () => {
        await measureB5Stage("jwtVerify", async () => undefined);
        await measureB5Stage("profileRead", async () => undefined);
        await measureB5Stage("financialRpc", async () => undefined);
        emitter.emit("finish");
        emitter.emit("close");
      })();
    }) as NextFunction;

    b5TraceMiddleware(req, res, next);
    await completed;
    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("X-PowerHub-B5-Trace")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[0]).toBe("[PowerHub B5 HTTPS trace]");
    const body = entries[0]?.[1] as Record<string, unknown>;
    expect(body.route).toBe("financialGLSiteStatements");
    expect(body.functionRegion).toBe("sin1");
    expect(body.completion).toBe("finish");
    expect(body.stageMs).toMatchObject({
      jwtVerify: expect.any(Number),
      profileRead: expect.any(Number),
      financialRpc: expect.any(Number),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("PRIVATE_INPUT");
    expect(encoded).not.toContain("authorization");
    expect(encoded).not.toContain("deviceId");
    expect(encoded).not.toContain("userId");
  });

  it("leaves other routes unchanged and does not emit telemetry", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const logger = vi.spyOn(console, "info").mockImplementation(() => {});
    const next = vi.fn();
    const req = { originalUrl: "/api/trpc/powerhub.reports.financialGLSiteStatements", method: "GET" } as Request;
    b5TraceMiddleware(req, { setHeader: vi.fn() } as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect(logger).not.toHaveBeenCalled();
  });
});
