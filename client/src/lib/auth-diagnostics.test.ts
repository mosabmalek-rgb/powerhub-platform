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

  it("recognizes session-token errors wrapped by the RPC client", () => {
    const wrapped = {
      name: "TRPCClientError",
      cause: Object.assign(new Error("wrapped detail"), { name: "PowerHubSessionTokenUnavailableError" }),
    };
    expect(describeAuthFailure(wrapped)).toContain("Access Token");
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
