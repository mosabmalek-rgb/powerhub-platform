import crypto from "node:crypto";
import type { Request, RequestHandler } from "express";
import { supabaseAdmin } from "./supabase-admin";

function rateLimitSecret(): string {
  const secret = process.env.JWT_SECRET?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("A server-side rate-limit HMAC secret of at least 32 characters is required.");
  }
  return secret;
}

export function getClientIp(req: Pick<Request, "ip" | "headers" | "socket">): string {
  return req.ip?.trim() || req.socket.remoteAddress?.trim() || "unknown";
}

export function hashRateLimitKey(scope: string, keyMaterial: string): string {
  if (!scope.trim() || !keyMaterial.trim()) {
    throw new Error("HTTP rate-limit scope and key material must be non-empty.");
  }
  return crypto
    .createHmac("sha256", rateLimitSecret())
    .update(`${scope}:${keyMaterial}`, "utf8")
    .digest("hex");
}

export async function consumeHttpRateLimit(input: {
  req: Pick<Request, "ip" | "headers" | "socket">;
  scope: string;
  keyMaterial?: string;
  windowSeconds: number;
  maxAttempts: number;
}): Promise<boolean> {
  const keyMaterial = input.keyMaterial ?? getClientIp(input.req);
  const keyHash = hashRateLimitKey(input.scope, keyMaterial);
  const { data, error } = await supabaseAdmin().rpc("powerhub_http_rate_limit_consume", {
    p_key_hash: keyHash,
    p_scope: input.scope,
    p_window_seconds: input.windowSeconds,
    p_max_attempts: input.maxAttempts,
  });

  if (error) throw new Error(`HTTP rate limiter unavailable: ${error.message}`);
  return data === true;
}

/**
 * Express 4 does not automatically forward rejected async middleware promises.
 * Handle both the rate-limit decision and dependency failure here so a missing
 * limiter never allows the protected request through or leaves it hanging.
 */
export function httpRateLimitMiddleware(input: {
  scope: string;
  windowSeconds: number;
  maxAttempts: number;
  blockedRetryAfterSeconds?: number;
  unavailableRetryAfterSeconds?: number;
}): RequestHandler {
  return (req, res, next) => {
    void consumeHttpRateLimit({
      req,
      scope: input.scope,
      windowSeconds: input.windowSeconds,
      maxAttempts: input.maxAttempts,
    }).then((allowed) => {
      if (!allowed) {
        res.setHeader("Retry-After", String(input.blockedRetryAfterSeconds ?? input.windowSeconds));
        res.status(429).json({ error: "rate_limit_exceeded" });
        return;
      }
      next();
    }).catch((error: unknown) => {
      console.error("[PowerHub] HTTP rate limiter unavailable", {
        scope: input.scope,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      if (res.headersSent) return;
      res.setHeader("Retry-After", String(input.unavailableRetryAfterSeconds ?? 30));
      res.status(503).json({ error: "rate_limit_unavailable" });
    });
  };
}
