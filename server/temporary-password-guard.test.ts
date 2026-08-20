import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { authenticatedProcedure, protectedProcedure, router } from "./_core/trpc";

const guardRouter = router({
  operatingAction: protectedProcedure.query(() => ({ ok: true })),
  auth: router({ updatePassword: authenticatedProcedure.query(() => ({ ok: true })) }),
});

const temporaryPasswordUser = {
  id: 77,
  openId: "supabase-owner",
  name: "صاحب مولد",
  email: "owner@powerhub.test",
  loginMethod: "supabase",
  role: "user" as const,
  platformRole: null,
  accountStatus: "active" as const,
  mustChangePassword: true,
  temporaryPasswordIssuedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  lastSignedIn: new Date(),
};

describe("temporary password guard", () => {
  it("blocks operating procedures until the temporary password is changed", async () => {
    const caller = guardRouter.createCaller({ user: temporaryPasswordUser, req: {} as never, res: {} as never });
    await expect(caller.operatingAction()).rejects.toMatchObject<Partial<TRPCError>>({ code: "PRECONDITION_FAILED" });
  });

  it("allows the account security procedure while the password change is pending", async () => {
    const caller = guardRouter.createCaller({ user: temporaryPasswordUser, req: {} as never, res: {} as never });
    await expect(caller.auth.updatePassword()).resolves.toEqual({ ok: true });
  });
});
