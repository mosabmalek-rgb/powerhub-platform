import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { supabaseAdmin } from "./supabase-admin";
import { requireSupabaseSiteRole } from "./powerhub-supabase";

const dashboardRoles = ["owner", "manager", "accountant", "collector", "technician", "viewer"] as const;
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "التاريخ يجب أن يكون بصيغة YYYY-MM-DD.");
const periodInput = z.object({
  siteId: z.number().int().positive(),
  from: dateSchema,
  to: dateSchema,
}).superRefine((value, ctx) => {
  if (value.from > value.to) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "نهاية الفترة يجب ألا تسبق بدايتها." });
});

function periodBounds(from: string, to: string) {
  const start = new Date(`${from}T00:00:00.000Z`);
  const endExclusive = new Date(`${to}T00:00:00.000Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  return { start: start.toISOString(), endExclusive: endExclusive.toISOString() };
}

export const powerhubDashboardRouter = router({
  readingKpis: protectedProcedure.input(periodInput).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...dashboardRoles]);
    const { start, endExclusive } = periodBounds(input.from, input.to);
    const { data, error } = await supabaseAdmin().rpc("powerhub_dashboard_reading_kpis", {
      p_tenant_id: access.tenantId,
      p_site_id: input.siteId,
      p_from: start,
      p_to: endExclusive,
    });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل مؤشرات القراءات من قاعدة البيانات." });
    return data as {
      consumption: number | string;
      average: number | string;
      approvedCount: number;
      pendingCount: number;
      latestReadingAt: string | null;
    };
  }),
  collectorPerformance: protectedProcedure.input(periodInput).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, [...dashboardRoles]);
    const { start, endExclusive } = periodBounds(input.from, input.to);
    const { data, error } = await supabaseAdmin().rpc("powerhub_dashboard_collector_performance", {
      p_tenant_id: access.tenantId,
      p_site_id: input.siteId,
      p_from: start,
      p_to: endExclusive,
    });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أداء المحصلين من قاعدة البيانات." });
    return data as {
      openCount: number;
      closedCount: number;
      varianceCount: number;
      netVariance: number | string;
      collectors: Array<{ name: string; sessions: number; variance: number | string }>;
    };
  }),
});
