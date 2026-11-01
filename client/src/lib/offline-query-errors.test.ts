import { describe, expect, it } from "vitest";
import { isExplicitAuthorizationDenial } from "./offline-query-errors";

describe("offline query authorization-denial handling", () => {
  it("treats direct tRPC unauthorized and forbidden errors as explicit denials", () => {
    expect(isExplicitAuthorizationDenial({ data: { code: "UNAUTHORIZED" } })).toBe(true);
    expect(isExplicitAuthorizationDenial({ data: { code: "FORBIDDEN" } })).toBe(true);
    expect(isExplicitAuthorizationDenial({ shape: { data: { code: "FORBIDDEN" } } })).toBe(true);
  });

  it("detects explicit denials nested under a transport wrapper", () => {
    expect(isExplicitAuthorizationDenial({
      name: "TRPCClientError",
      cause: { data: { code: "FORBIDDEN" } },
    })).toBe(true);
    expect(isExplicitAuthorizationDenial({ response: { status: 401 } })).toBe(true);
    expect(isExplicitAuthorizationDenial({ status: 403 })).toBe(true);
  });

  it("does not treat network and server failures as access revocation", () => {
    expect(isExplicitAuthorizationDenial(new Error("Failed to fetch"))).toBe(false);
    expect(isExplicitAuthorizationDenial({ data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
    expect(isExplicitAuthorizationDenial(null)).toBe(false);
  });

  it("safely handles a cyclic error cause chain", () => {
    const error: { data: { code: string }; cause?: unknown } = { data: { code: "INTERNAL_SERVER_ERROR" } };
    error.cause = error;
    expect(isExplicitAuthorizationDenial(error)).toBe(false);
  });
});
