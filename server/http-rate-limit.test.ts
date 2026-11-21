import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({ rpc: state.rpc }),
}));

import { hashRateLimitKey, httpRateLimitMiddleware } from "./http-rate-limit";

function responseRecorder() {
  const response: any = {
    headersSent: false,
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
  };
  response.setHeader = (name: string, value: string) => {
    response.headers[name] = value;
    return response;
  };
  response.status = (statusCode: number) => {
    response.statusCode = statusCode;
    return response;
  };
  response.json = (body: unknown) => {
    response.body = body;
    return response;
  };
  return response;
}

const request = {
  ip: "203.0.113.10",
  headers: { "x-forwarded-for": "198.51.100.99" },
  socket: { remoteAddress: "203.0.113.10" },
};

describe("HTTP rate-limit hardening", () => {
  beforeEach(() => {
    vi.stubEnv("JWT_SECRET", "test-http-rate-limit-secret-at-least-32-characters");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    state.rpc.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses opaque deterministic scoped hashes", () => {
    const first = hashRateLimitKey("mobile-login-ip", "203.0.113.10");
    expect(first).toHaveLength(64);
    expect(first).toBe(hashRateLimitKey("mobile-login-ip", "203.0.113.10"));
    expect(first).not.toBe(hashRateLimitKey("mobile-login-email-ip", "203.0.113.10"));
    expect(first).not.toContain("203.0.113.10");
  });

  it("fails closed when no valid server-side HMAC secret is configured", () => {
    vi.stubEnv("JWT_SECRET", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(() => hashRateLimitKey("whatsapp-webhook", "203.0.113.10"))
      .toThrow("A server-side rate-limit HMAC secret of at least 32 characters is required.");
  });

  it("allows the request only after the atomic limiter confirms capacity", async () => {
    state.rpc.mockResolvedValue({ data: true, error: null });
    const response = responseRecorder();
    const next = vi.fn();

    httpRateLimitMiddleware({
      scope: "whatsapp-webhook-verify-ip",
      windowSeconds: 300,
      maxAttempts: 30,
    })(request as never, response as never, next);

    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    expect(response.statusCode).toBe(0);
    expect(state.rpc).toHaveBeenCalledWith("powerhub_http_rate_limit_consume", expect.objectContaining({
      p_scope: "whatsapp-webhook-verify-ip",
      p_window_seconds: 300,
      p_max_attempts: 30,
      p_key_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it("returns 429 and Retry-After when the atomic limiter denies capacity", async () => {
    state.rpc.mockResolvedValue({ data: false, error: null });
    const response = responseRecorder();
    const next = vi.fn();

    httpRateLimitMiddleware({
      scope: "whatsapp-webhook-delivery-ip",
      windowSeconds: 300,
      maxAttempts: 300,
    })(request as never, response as never, next);

    await vi.waitFor(() => expect(response.statusCode).toBe(429));
    expect(response.headers["Retry-After"]).toBe("300");
    expect(response.body).toEqual({ error: "rate_limit_exceeded" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns a fail-closed 503 instead of leaving an Express 4 request pending on RPC error", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "database unavailable" } });
    const response = responseRecorder();
    const next = vi.fn();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    httpRateLimitMiddleware({
      scope: "whatsapp-webhook-verify-ip",
      windowSeconds: 300,
      maxAttempts: 30,
    })(request as never, response as never, next);

    await vi.waitFor(() => expect(response.statusCode).toBe(503));
    expect(response.headers["Retry-After"]).toBe("30");
    expect(response.body).toEqual({ error: "rate_limit_unavailable" });
    expect(JSON.stringify(response.body)).not.toContain("database unavailable");
    expect(next).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith("[PowerHub] HTTP rate limiter unavailable", expect.objectContaining({
      scope: "whatsapp-webhook-verify-ip",
      errorName: "Error",
    }));
  });

  it("returns a fail-closed 503 when the Supabase limiter rejects its promise", async () => {
    state.rpc.mockRejectedValue(new Error("network disconnected"));
    const response = responseRecorder();
    const next = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    httpRateLimitMiddleware({
      scope: "whatsapp-webhook-delivery-ip",
      windowSeconds: 300,
      maxAttempts: 300,
    })(request as never, response as never, next);

    await vi.waitFor(() => expect(response.statusCode).toBe(503));
    expect(response.body).toEqual({ error: "rate_limit_unavailable" });
    expect(next).not.toHaveBeenCalled();
  });
});
