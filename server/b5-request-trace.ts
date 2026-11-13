import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * B5.22: preview-only, one-summary-per-request timings for the exact three
 * authenticated financial acceptance GETs. Correlation IDs are freshly random
 * and never derived from user, tenant, site, device, JWT, URL inputs or IP.
 *
 * This trace is observational. It must not cache access, alter timeouts, bypass
 * security checks, retry financial calls, or persist any financial information.
 */
export const B5_TRACE_ROUTES = [
  "financialGLSubledgerReconciliation",
  "financialGLCompanyMovementAudit",
  "financialGLSiteStatements",
] as const;

export type B5TraceStage =
  | "jwtVerify"
  | "profileRead"
  | "deviceClaim"
  | "maintenanceRead"
  | "siteAccessRpc"
  | "financialRpc";

type B5Trace = {
  traceId: string;
  route: (typeof B5_TRACE_ROUTES)[number];
  startedAt: number;
  stageDurationsMs: Partial<Record<B5TraceStage, number>>;
  failedStage?: B5TraceStage;
};

const traceStorage = new AsyncLocalStorage<B5Trace>();
const routeNames = new Set<string>(B5_TRACE_ROUTES);
const previewPathPrefix = "/api/trpc/powerhub.reports.";

/** Exact allowed path only; no query string, arbitrary route or user value. */
export function getB5TraceRoute(originalUrl: string, method: string, env: NodeJS.ProcessEnv = process.env) {
  if (method !== "GET" || env.VERCEL_ENV !== "preview") return null;
  const path = originalUrl.split("?", 1)[0];
  if (!path.startsWith(previewPathPrefix)) return null;
  const candidate = path.slice(previewPathPrefix.length);
  if (!routeNames.has(candidate)) return null;
  return candidate as (typeof B5_TRACE_ROUTES)[number];
}

/**
 * Include every stage (including fast stages and rejected calls) in one fixed
 * schema. The remaining time includes request/response overhead and queues,
 * not necessarily PostgreSQL execution. Never claim RPC round trip is DB-only.
 */
export async function measureB5Stage<T>(stage: B5TraceStage, work: () => PromiseLike<T>): Promise<T> {
  const current = traceStorage.getStore();
  if (!current) return work();
  const startedAt = performance.now();
  try {
    return await work();
  } catch (error) {
    current.failedStage ??= stage;
    throw error;
  } finally {
    const elapsed = Math.round((performance.now() - startedAt) * 10) / 10;
    current.stageDurationsMs[stage] = Math.round(
      ((current.stageDurationsMs[stage] ?? 0) + elapsed) * 10,
    ) / 10;
  }
}

/**
 * Register directly before tRPC middleware so createContext, security checks,
 * site authorization and report handlers share the same AsyncLocalStorage.
 * Header is a random per-request correlation handle, not an auth token.
 */
export function b5TraceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const route = getB5TraceRoute(req.originalUrl, req.method);
  if (!route) {
    next();
    return;
  }
  const trace: B5Trace = {
    traceId: randomUUID(),
    route,
    startedAt: performance.now(),
    stageDurationsMs: {},
  };
  res.setHeader("X-PowerHub-B5-Trace", trace.traceId);
  res.setHeader("Cache-Control", "no-store");
  let emitted = false;
  const emit = (completion: "finish" | "close") => {
    if (emitted) return;
    emitted = true;
    const totalMs = Math.round((performance.now() - trace.startedAt) * 10) / 10;
    const recordedMs = Object.values(trace.stageDurationsMs).reduce((sum, ms) => sum + ms, 0);
    const unmeasuredMs = Math.max(0, Math.round((totalMs - recordedMs) * 10) / 10);
    // No headers, IP, query inputs, status-specific error bodies, user or device IDs.
    console.info("[PowerHub B5 HTTPS trace]", {
      traceId: trace.traceId,
      route: trace.route,
      completion,
      status: res.statusCode,
      totalMs,
      stageMs: trace.stageDurationsMs,
      unmeasuredMs,
      failedStage: trace.failedStage ?? null,
      functionRegion: process.env.VERCEL_REGION ?? "unknown",
      awsRegion: process.env.AWS_REGION ?? "unknown",
      deploymentRegionConfig: "sin1",
    });
  };
  res.once("finish", () => emit("finish"));
  res.once("close", () => emit("close"));
  traceStorage.run(trace, next);
}
