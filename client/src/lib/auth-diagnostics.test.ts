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

  it("explains an underlying session-read failure instead of masking it as a missing token", () => {
    const wrapped = {
      name: "TRPCClientError",
      cause: Object.assign(new Error("private refresh storage detail"), { name: "PowerHubSessionReadFailedError" }),
    };
    const hint = describeAuthFailure(wrapped);
    expect(hint).toContain("فشلت قراءة جلسة Supabase");
    expect(hint).toContain("لم يُرسل طلب API المحمي");
    expect(hint).not.toContain("private refresh storage detail");
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

  it("distinguishes refresh timeout and failure without exposing token data", () => {
    const timedOut = {
      name: "TRPCClientError",
      cause: Object.assign(new Error("private refresh token data"), { name: "PowerHubSessionRefreshTimeoutError" }),
    };
    const failed = {
      name: "TRPCClientError",
      cause: Object.assign(new Error("private refresh token data"), { name: "PowerHubSessionRefreshFailedError" }),
    };
    expect(describeAuthFailure(timedOut)).toContain("انتظر المتصفح تجديد جلسة Supabase");
    expect(describeAuthFailure(failed)).toContain("فشل تجديد جلسة Supabase");
    expect(describeAuthFailure(timedOut)).not.toContain("private refresh token data");
    expect(describeAuthFailure(failed)).not.toContain("private refresh token data");
  });

  it("explains identity changes without exposing session details", () => {
    const error = {
      name: "TRPCClientError",
      cause: Object.assign(new Error("user-b token should never be logged"), {
        name: "PowerHubSessionIdentityChangedError",
      }),
    };
    expect(describeAuthFailure(error)).toContain("تغيّرت هوية حساب Supabase");
    expect(describeAuthFailure(error)).not.toContain("user-b token");
  });

  it("distinguishes a stalled auth profile check from a session read failure", () => {
    expect(describeAuthFailure({ name: "PowerHubAuthProfileCheckTimeoutError" })).toContain("طلب auth.me");
    expect(describeAuthFailure({ name: "PowerHubSessionRecoveryTimeoutError" })).toContain("لم تصل جلسة صالحة بعد محاولة استعادة Supabase");
  });

  it("explains a completed recovery failure without confusing it with a timeout", () => {
    const wrapped = {
      name: "TRPCClientError",
      cause: Object.assign(new Error("private local session state"), { name: "PowerHubSessionRecoveryFailedError" }),
    };
    const hint = describeAuthFailure(wrapped);
    expect(hint).toContain("اكتملت قراءة جلسة Supabase");
    expect(hint).toContain("أعد المحاولة أو افتح تسجيل الدخول");
    expect(hint).not.toContain("private local session state");
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

  it("distinguishes device-lock denial from ordinary account authorization denial", () => {
    const deviceLock = {
      message: "هذا الحساب مستخدم حاليًا على جهاز آخر. سجّل الخروج من الجهاز الآخر ثم حاول مرة أخرى.",
      data: { code: "FORBIDDEN" },
    };
    const ordinaryPermission = {
      message: "You do not have permission to perform this action.",
      data: { code: "FORBIDDEN" },
    };
    const deviceHint = describeAuthFailure(deviceLock);
    expect(deviceHint).toContain("مقيد بجهاز آخر");
    expect(deviceHint).toContain("لن نمسح الكاش");
    expect(describeAuthFailure(ordinaryPermission)).toContain("صلاحية الحساب أو العملية");
    expect(describeAuthFailure(ordinaryPermission)).not.toContain("مقيد بجهاز آخر");
  });

  it("explains an invalid device identity without leaking the raw server message", () => {
    const hint = describeAuthFailure({
      message: "تعذر التحقق من جهاز الدخول.",
      data: { code: "FORBIDDEN" },
    });
    expect(hint).toContain("هوية جهاز الدخول");
    expect(hint).not.toContain("تعذر التحقق من جهاز الدخول.");
  });

  it("distinguishes authorization rejection from a server-side failure", () => {
    expect(describeAuthFailure({ data: { code: "UNAUTHORIZED" } })).toContain("لم يُقبل");
    expect(describeAuthFailure({ data: { code: "FORBIDDEN" } })).toContain("صلاحية الحساب أو العملية");
    expect(describeAuthFailure({ data: { code: "INTERNAL_SERVER_ERROR" } })).toContain("ملف المستخدم");
  });
});
