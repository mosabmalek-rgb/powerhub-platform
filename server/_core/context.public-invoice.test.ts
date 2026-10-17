import { afterEach, describe, expect, it, vi } from "vitest";
import { createContext } from "./context";
import { authenticateSupabaseRequest } from "./supabase-auth";

vi.mock("./supabase-auth", () => ({
  authenticateSupabaseRequest: vi.fn(),
}));

function makeOptions(path: string, originalUrl: string) {
  return {
    req: { path, originalUrl, headers: {} },
    res: {},
  } as never;
}

describe("tRPC context authentication for public invoice lookup", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not run user authentication/profile sync for the standalone public invoice procedure", async () => {
    const context = await createContext(makeOptions(
      "/powerhub.invoices.publicByToken",
      "/api/trpc/powerhub.invoices.publicByToken?input=%7B%7D",
    ));

    expect(context.user).toBeNull();
    expect(authenticateSupabaseRequest).not.toHaveBeenCalled();
  });

  it("keeps normal authentication for protected procedures", async () => {
    vi.mocked(authenticateSupabaseRequest).mockResolvedValue(null as never);

    const context = await createContext(makeOptions(
      "/powerhub.staff.myAccess",
      "/api/trpc/powerhub.staff.myAccess?input=%7B%7D",
    ));

    expect(context.user).toBeNull();
    expect(authenticateSupabaseRequest).toHaveBeenCalledOnce();
  });

  it("does not bypass authentication for a batched request containing the public invoice procedure", async () => {
    vi.mocked(authenticateSupabaseRequest).mockResolvedValue(null as never);

    const context = await createContext(makeOptions(
      "/powerhub.invoices.publicByToken,powerhub.staff.myAccess",
      "/api/trpc/powerhub.invoices.publicByToken,powerhub.staff.myAccess?batch=1",
    ));

    expect(context.user).toBeNull();
    expect(authenticateSupabaseRequest).toHaveBeenCalledOnce();
  });
});
