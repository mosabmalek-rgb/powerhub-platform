import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { HttpError } from "@shared/_core/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateSupabaseRequest } from "./supabase-auth";
import { createContext } from "./context";

vi.mock("./supabase-auth", () => ({
  authenticateSupabaseRequest: vi.fn(),
}));

const mockUser = {
  id: 12,
  openId: "auth-user-12",
  name: "Test user",
  email: "test@example.com",
  loginMethod: "supabase",
  role: "user" as const,
  platformRole: null,
  accountStatus: "active" as const,
  mustChangePassword: false,
  temporaryPasswordIssuedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  lastSignedIn: new Date("2026-01-01T00:00:00.000Z"),
};

function contextOptions(): CreateExpressContextOptions {
  return {
    req: {
      originalUrl: "/api/trpc/auth.me",
      path: "/api/trpc/auth.me",
      headers: { authorization: "Bearer test-token" },
    },
    res: {},
  } as unknown as CreateExpressContextOptions;
}

describe("authentication context error classification", () => {
  beforeEach(() => vi.resetAllMocks());

  it("keeps rejected credentials as an unauthenticated state", async () => {
    vi.mocked(authenticateSupabaseRequest).mockRejectedValue(new HttpError(403, "Invalid Supabase access token"));
    const context = await createContext(contextOptions());
    expect(context.user).toBeNull();
    expect(context.authError).toBeNull();
  });

  it("preserves profile/database/network failures as retryable context errors", async () => {
    const databaseFailure = new Error("profile database unavailable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(authenticateSupabaseRequest).mockRejectedValue(databaseFailure);

    const context = await createContext(contextOptions());

    expect(context.user).toBeNull();
    expect(context.authError).toBe(databaseFailure);
    expect(warn).toHaveBeenCalledWith("[PowerHub auth context failure]", expect.objectContaining({
      stage: "authenticateSupabaseRequest",
      errorName: "Error",
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("profile database unavailable");
    warn.mockRestore();
  });

  it("keeps the authenticated profile when token validation succeeds", async () => {
    vi.mocked(authenticateSupabaseRequest).mockResolvedValue(mockUser);
    const context = await createContext(contextOptions());
    expect(context.user).toEqual(mockUser);
    expect(context.authError).toBeNull();
  });

  it("does not run an unrelated Supabase auth check for the standalone public invoice", async () => {
    const opts = contextOptions();
    opts.req.originalUrl = "/api/trpc/powerhub.invoices.publicByToken?input=%7B%7D";
    opts.req.path = "/api/trpc/powerhub.invoices.publicByToken";
    const context = await createContext(opts);
    expect(authenticateSupabaseRequest).not.toHaveBeenCalled();
    expect(context).toMatchObject({ user: null, authError: null });
  });
});
