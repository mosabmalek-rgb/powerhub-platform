import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import superjson from "superjson";
import { platformSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

const enforceMaintenanceMode = t.middleware(async opts => {
  const user = opts.ctx.user;
  if (!user || user.role === "admin" || opts.path === "auth.me") return opts.next();
  const db = await getDb();
  if (!db) return opts.next();
  const [maintenance] = await db.select({ isEnabled: platformSettings.isEnabled, message: platformSettings.message })
    .from(platformSettings).where(eq(platformSettings.settingKey, "maintenance_mode")).limit(1);
  if (maintenance?.isEnabled) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: maintenance.message || "المنصة تحت الصيانة مؤقتاً. يرجى المحاولة لاحقاً." });
  }
  return opts.next();
});

export const protectedProcedure = t.procedure.use(requireUser).use(enforceMaintenanceMode);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
