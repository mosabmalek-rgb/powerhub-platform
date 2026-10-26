import { describe, expect, it } from "vitest";
import { describeAuthFailure } from "./auth-diagnostics";

describe("safe authentication diagnostics", () => {
  it("identifies unavailable access tokens before API requests without leaking raw errors", () => {
    const error = Object.assign(new Error("private token detail must not be exposed"), {
      name: "PowerHubSessionTokenUnavailableError",
    });
    const hint = describeAuthFailure(error);
    expect(hint).toContain("Access Token");
    expect(hint).toContain("لم يُرسل طلب API");
    expect(hint).not.toContain("private token detail");
  });

  it("explains Supabase refresh rate limiting without exposing raw SDK errors", () => {
    const wrapped = {
      name: "TRPCClientError",
      cause: Object.assign(new Error("private refresh token payload"), { name: "PowerHubSupabaseRateLimitError" }),
    };
    const hint = describeAuthFailure(wrapped);
    expect(hint).toContain("حدّ Supabase مؤقتًا");
    expect(hint).not.toContain("private refresh token payload");
  });

  it("recognizes session-token errors wrapped by the RPC client", () => {
    const wrapped = {
      name: "TRPCClientError",
      cause: Object.assign(new Error("wrapped detail"), { name: "PowerHubSessionTokenUnavailableError" }),
    };
    expect(describeAuthFailure(wrapped)).toContain("Access Token");
  });

  it("recognizes a wrapped Supabase session-read timeout without exposing internals", () => {
    const wrapped = {
      name: "TRPCClientError",
      cause: Object.assign(new Error("storage lock details"), { name: "PowerHubSessionReadTimeoutError" }),
    };
    const hint = describeAuthFailure(wrapped);
    expect(hint).toContain("انتهت مهلة قراءة جلسة Supabase");
    expect(hint).not.toContain("storage lock details");
  });

  it("distinguishes a stalled auth profile check from a session read failure", () => {
    expect(describeAuthFailure({ name: "PowerHubAuthProfileCheckTimeoutError" })).toContain("طلب auth.me");
    expect(describeAuthFailure({ name: "PowerHubSessionRecoveryTimeoutError" })).toContain("لم تصل جلسة صالحة بعد محاولة استعادة Supabase");
  });

  it("recognizes device identity errors wrapped by the RPC client", () => {
    const wrapped = {
      name: "TRPCClientError",
      cause: Object.assign(new Error("wrapped detail"), { name: "PowerHubDeviceIdentityUnavailableError" }),
    };
    expect(describeAuthFailure(wrapped)).toContain("معرّف الجهاز");
  });

  it("identifies device identity failures before sending protected requests", () => {
    const error = Object.assign(new Error("raw detail"), {
      name: "PowerHubDeviceIdentityUnavailableError",
    });
    expect(describeAuthFailure(error)).toContain("معرّف الجهاز");
  });

  it("distinguishes authorization rejection from a server-side failure", () => {
    expect(describeAuthFailure({ data: { code: "UNAUTHORIZED" } })).toContain("لم يُقبل");
    expect(describeAuthFailure({ data: { code: "FORBIDDEN" } })).toContain("جهاز الدخول");
    expect(describeAuthFailure({ data: { code: "INTERNAL_SERVER_ERROR" } })).toContain("ملف المستخدم");
  });
});
