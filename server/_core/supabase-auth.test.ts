import { describe, expect, it } from "vitest";
import { authenticateSupabaseRequest, isDefinitiveSupabaseAccessTokenRejection, isInvalidSupabaseJwtEnvelope } from "./supabase-auth";

describe("Supabase access-token error classification", () => {
  it("recognizes explicit invalid-token Auth errors", () => {
    expect(isDefinitiveSupabaseAccessTokenRejection({ name: "AuthApiError", status: 401, code: "bad_jwt" })).toBe(true);
    expect(isDefinitiveSupabaseAccessTokenRejection({ name: "AuthApiError", status: 400, code: "session_not_found" })).toBe(true);
    expect(isDefinitiveSupabaseAccessTokenRejection({ name: "AuthApiError", status: 401, code: "invalid_token" })).toBe(true);
  });

  it("does not classify throttling, timeout, transport, or Auth service faults as logout", () => {
    expect(isDefinitiveSupabaseAccessTokenRejection({ name: "AuthApiError", status: 429, code: "over_request_rate_limit" })).toBe(false);
    expect(isDefinitiveSupabaseAccessTokenRejection({ name: "AuthApiError", status: 503, code: "unexpected_failure" })).toBe(false);
    expect(isDefinitiveSupabaseAccessTokenRejection({ name: "AuthApiError", status: 408, code: "request_timeout" })).toBe(false);
    expect(isDefinitiveSupabaseAccessTokenRejection({ name: "AuthRetryableFetchError" })).toBe(false);
    expect(isDefinitiveSupabaseAccessTokenRejection(new TypeError("Failed to fetch"))).toBe(false);
    expect(isDefinitiveSupabaseAccessTokenRejection({ name: "AuthApiError", status: 403, code: "feature_not_enabled" })).toBe(false);
  });
});

describe("Supabase JWT local rejection-only preflight", () => {
  const fixedNow = Date.parse("2026-11-15T19:35:00Z");
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = (payload: Record<string, unknown>, alg = "HS256") =>
    `${encode({ alg, typ: "JWT" })}.${encode(payload)}.${Buffer.alloc(32, 7).toString("base64url")}`;

  it("rejects malformed bearer values without contacting Supabase Auth", async () => {
    for (const invalid of ["bad-token", "abc.def.ghi", "abc..ghi", "abc.def.ghi.extra"]) {
      expect(isInvalidSupabaseJwtEnvelope(invalid, fixedNow)).toBe(true);
      await expect(authenticateSupabaseRequest({
        headers: { authorization: `Bearer ${invalid}` },
      })).rejects.toMatchObject({ statusCode: 403 });
    }
  });

  it("rejects expired or missing-expiration JWT envelopes locally", () => {
    expect(isInvalidSupabaseJwtEnvelope(token({ sub: "user-1", exp: fixedNow / 1000 - 1 }), fixedNow)).toBe(true);
    expect(isInvalidSupabaseJwtEnvelope(token({ sub: "user-1" }), fixedNow)).toBe(true);
    expect(isInvalidSupabaseJwtEnvelope(token({ sub: "user-1", exp: "invalid" }), fixedNow)).toBe(true);
    expect(isInvalidSupabaseJwtEnvelope(token({ sub: "user-1", exp: fixedNow / 1000 + 1800 }, "none"), fixedNow)).toBe(true);
  });

  it("does not authenticate a plausible but forged token locally", () => {
    const plausible = token({ sub: "user-1", role: "authenticated", exp: fixedNow / 1000 + 3600 });
    // A false preflight result means 'continue to signature verification', never 'accept'.
    expect(isInvalidSupabaseJwtEnvelope(plausible, fixedNow)).toBe(false);
    expect(isDefinitiveSupabaseAccessTokenRejection({ name: "AuthApiError", status: 401, code: "bad_jwt" })).toBe(true);
  });

  it("does not convert genuine upstream transport/throttling into credential denial", () => {
    expect(isDefinitiveSupabaseAccessTokenRejection({ name: "AuthApiError", status: 429, code: "over_request_rate_limit" })).toBe(false);
    expect(isDefinitiveSupabaseAccessTokenRejection({ name: "AuthRetryableFetchError" })).toBe(false);
  });
});
