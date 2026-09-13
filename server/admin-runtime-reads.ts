import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { supabaseAdmin } from "./supabase-admin";
import { adminRouter } from "./admin-runtime";

const legacyRecord = (adminRouter as any)._def.record as Record<string, any>;
const platformAdminProcedure = authenticatedProcedure.use(({ ctx, next }) => {
  const platformRole = ctx.user.platformRole ?? "platform_admin";
  if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(platformRole) || ctx.user.accountStatus !== "active") {
    throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
  }
  return next({ ctx });
});

const reportInput = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
}).optional();

export const adminRouterWithSupabaseReadContracts = router({
  ...legacyRecord,

  platformTweetSmsReport: platformAdminProcedure.input(reportInput).query(async ({ input }) => {
    const { data, error } = await supabaseAdmin().rpc("powerhub_tweetsms_report", {
      p_from: input?.from?.toISOString() ?? null,
      p_to: input?.to?.toISOString() ?? null,
    });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تقرير TweetSMS المركزي من Supabase." });
    const report = (data as Array<{ account?: unknown; total?: string | number | null; usage_rows?: unknown; alerts?: unknown }> | null)?.[0];
    if (!report) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة تقرير TweetSMS استجابة صالحة." });
    const usageRows = Array.isArray(report.usage_rows)
      ? (report.usage_rows as Array<Record<string, unknown>>).map((row) => ({
          ...row,
          tenantId: row.tenant_id === undefined ? undefined : Number(row.tenant_id),
        }))
      : [];
    const alerts = Array.isArray(report.alerts)
      ? (report.alerts as Array<Record<string, unknown>>).map((row) => ({
          ...row,
          id: row.id === undefined ? undefined : Number(row.id),
        }))
      : [];
    return { account: report.account ?? null, total: Number(report.total ?? 0), usageRows, alerts };
  }),

  advancedDashboard: platformAdminProcedure.query(async () => {
    const { data, error } = await supabaseAdmin().rpc("powerhub_advanced_dashboard");
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل لوحة التحليلات المركزية من Supabase." });
    const dashboard = (data as Array<Record<string, unknown>> | null)?.[0];
    if (!dashboard) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة لوحة التحليلات استجابة صالحة." });
    return dashboard;
  }),
});
