import { describe, expect, it } from "vitest";
import { hashRateLimitKey } from "./http-rate-limit";

describe("HTTP rate-limit hardening", () => {
  it("uses opaque deterministic scoped hashes", () => {
    const first = hashRateLimitKey("mobile-login-ip", "203.0.113.10");
    expect(first).toHaveLength(64);
    expect(first).toBe(hashRateLimitKey("mobile-login-ip", "203.0.113.10"));
    expect(first).not.toBe(hashRateLimitKey("mobile-login-email-ip", "203.0.113.10"));
    expect(first).not.toContain("203.0.113.10");
  });
});
