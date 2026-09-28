import crypto from "node:crypto";
import type { Request } from "express";
import { supabaseAdmin } from "./supabase-admin";

function rateLimitSecret() {
  return process.env.JWT_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "powerhub-development-rate-limit";
}

export function getClientIp(req: Pick<Request, "ip" | "headers" | "socket">): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }
  if (Array.isArray(forwardedFor) && forwardedFor[0]?.trim()) return forwardedFor[0].trim();
  return req.ip?.trim() || req.socket.remoteAddress?.trim() || "unknown";
}

export function hashRateLimitKey(scope: string, keyMaterial: string): string {
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