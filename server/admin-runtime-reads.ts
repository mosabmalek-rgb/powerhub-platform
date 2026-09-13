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

const reportInput = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).optional();
const generatorStatusInput = z.object({ id: z.number().int().positive(), status: z.enum(["active", "maintenance", "stopped", "offline", "blocked"]) });
const generatorApprovalInput = z.object({ generatorId: z.number().int().positive() });

async function writeGeneratorAudit(actorUserId: number, generator: { tenant_id: number; site_id: number }, generatorId: number, action: string, beforeStatus: string, afterStatus: string) {
  const { error } = await supabaseAdmin().from("audit_logs").insert({
    tenant_id: generator.tenant_id,
    site_id: generator.site_id,
    user_id: actorUserId,
    entity_type: "generator",
    entity_id: String(generatorId),
    action,
    before_data: { status: beforeStatus },
    after_data: { status: afterStatus },
  });
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تم تحديث حالة المولد لكن تعذر تسجيل التدقيق في Supabase." });
}

export const adminRouterWithSupabaseReadContracts = router({
  ...legacyRecord,

  platformTweetSmsReport: platformAdminProcedure.input(reportInput).query(async ({ input }) => {
    const { data, error } = await supabaseAdmin().rpc("powerhub_tweetsms_report", { p_from: input?.from?.toISOString() ?? null, p_to: input?.to?.toISOString() ?? null });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تقرير TweetSMS المركزي من Supabase." });
    const report = (data as Array<{ account?: unknown; total?: string | number | null; usage_rows?: unknown; alerts?: unknown }> | null)?.[0];
    if (!report) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة تقرير TweetSMS استجابة صالحة." });
    const usageRows = Array.isArray(report.usage_rows) ? (report.usage_rows as Array<Record<string, unknown>>).map((row) => ({ ...row, tenantId: row.tenant_id === undefined ? undefined : Number(row.tenant_id) })) : [];
    const alerts = Array.isArray(report.alerts) ? (report.alerts as Array<Record<string, unknown>>).map((row) => ({ ...row, id: row.id === undefined ? undefined : Number(row.id) })) : [];
    return { account: report.account ?? null, total: Number(report.total ?? 0), usageRows, alerts };
  }),

  advancedDashboard: platformAdminProcedure.query(async () => {
    const { data, error } = await supabaseAdmin().rpc("powerhub_advanced_dashboard");
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل لوحة التحليلات المركزية من Supabase." });
    const dashboard = (data as Array<Record<string, unknown>> | null)?.[0];
    if (!dashboard) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد دالة لوحة التحليلات استجابة صالحة." });
    return dashboard;
  }),

  setGeneratorStatus: platformAdminProcedure.input(generatorStatusInput).mutation(async ({ ctx, input }) => {
    const admin = supabaseAdmin();
    const { data: generator, error: generatorError } = await admin.from("generators").select("id,tenant_id,site_id,status").eq("id", input.id).maybeSingle();
    if (generatorError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المولد من Supabase." });
    if (!generator) throw new TRPCError({ code: "NOT_FOUND", message: "المولد غير موجود." });
    const { error: statusError } = await admin.from("generators").update({ status: input.status }).eq("id", input.id);
    if (statusError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديث حالة المولد في Supabase." });
    await writeGeneratorAudit(ctx.user.id, generator, input.id, "admin_set_generator_status", generator.status, input.status);
    return { success: true as const };
  }),

  approvePendingGenerator: platformAdminProcedure.input(generatorApprovalInput).mutation(async ({ ctx, input }) => {
    const admin = supabaseAdmin();
    const { data: generator, error: generatorError } = await admin.from("generators").select("id,tenant_id,site_id,status").eq("id", input.generatorId).maybeSingle();
    if (generatorError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المولد من Supabase." });
    if (!generator) throw new TRPCError({ code: "NOT_FOUND", message: "المولد غير موجود." });
    if (generator.status !== "pending") throw new TRPCError({ code: "CONFLICT", message: "لا يمكن اعتماد مولد ليس بانتظار المراجعة." });
    const { error: statusError } = await admin.from("generators").update({ status: "active" }).eq("id", input.generatorId).eq("status", "pending");
    if (statusError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر اعتماد المولد في Supabase." });
    await writeGeneratorAudit(ctx.user.id, generator, input.generatorId, "admin_approve_pending_generator", "pending", "active");
    return { success: true as const, generatorId: input.generatorId, status: "active" as const };
  }),
});
