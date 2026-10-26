import { describe, expect, it } from "vitest";
import { isDefinitiveSupabaseAccessTokenRejection } from "./supabase-auth";

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
