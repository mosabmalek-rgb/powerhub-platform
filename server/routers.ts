import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "../drizzle/schema";
import { getDb } from "./db";
import { systemRouter } from "./_core/systemRouter";
import { authenticatedProcedure, publicProcedure, router } from "./_core/trpc";
import { powerhubRouter } from "./powerhub";
import { adminRouter } from "./admin";
import { supabaseAdmin } from "./supabase-admin";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
    updateProfile: authenticatedProcedure.input(z.object({ name: z.string().min(2).max(180) })).mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      await db.update(users).set({ name: input.name.trim() }).where(eq(users.id, ctx.user.id));
      return { success: true } as const;
    }),
    updatePassword: authenticatedProcedure.input(z.object({ password: z.string().min(8).max(128) })).mutation(async ({ ctx, input }) => {
      const { error } = await supabaseAdmin().auth.admin.updateUserById(ctx.user.openId, { password: input.password });
      if (error) throw new Error("تعذر تحديث كلمة المرور في Supabase.");
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      await db.update(users).set({ mustChangePassword: false, temporaryPasswordIssuedAt: null }).where(eq(users.id, ctx.user.id));
      return { success: true } as const;
    }),
  }),
  powerhub: powerhubRouter,
  admin: adminRouter,

  // TODO: add feature routers here, e.g.
  // todo: router({
  //   list: protectedProcedure.query(({ ctx }) =>
  //     db.getUserTodos(ctx.user.id)
  //   ),
  // }),
});

export type AppRouter = typeof appRouter;
