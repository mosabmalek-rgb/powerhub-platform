import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { supabaseAdmin } from "./supabase-admin";

const performanceMetricsSchema = z.object({
  generatedAt: z.string().min(1),
  database: z.object({
    name: z.string(),
    sizeBytes: z.number().finite().nonnegative(),
    sizeMiB: z.number().finite().nonnegative(),
  }),
  connections: z.object({
    clientBackends: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    idleInTransaction: z.number().int().nonnegative(),
    maxConnections: z.number().int().positive(),
  }),
  cacheHitRatioPercent: z.number().finite().min(0).max(100).nullable(),
  transactions: z.object({
    commits: z.number().int().nonnegative(),
    rollbacks: z.number().int().nonnegative(),
    deadlocks: z.number().int().nonnegative(),
    tempFiles: z.number().int().nonnegative(),
    tempBytes: z.number().int().nonnegative(),
    statsResetAt: z.string().nullable(),
  }),
  topTables: z.array(z.object({
    schemaName: z.string(),
    tableName: z.string(),
    totalBytes: z.number().int().nonnegative(),
    indexBytes: z.number().int().nonnegative(),
    liveRowsEstimate: z.number().int().nonnegative(),
    deadRowsEstimate: z.number().int().nonnegative(),
  })).max(10),
});


const activityMetricsSchema = z.object({
  generatedAt: z.string().min(1),
  paymentDocumentation: z.object({
    totalRequests: z.number().int().nonnegative(),
    pendingRequests: z.number().int().nonnegative(),
    approvedRequests: z.number().int().nonnegative(),
    rejectedRequests: z.number().int().nonnegative(),
    requestsLast7Days: z.number().int().nonnegative(),
    requestsLast30Days: z.number().int().nonnegative(),
    approvedAmountAllTime: z.number().finite().nonnegative(),
    approvedAmountLast30Days: z.number().finite().nonnegative(),
    decidedRequests: z.number().int().nonnegative(),
    approvalRatePercent: z.number().finite().min(0).max(100).nullable(),
    latestSubmittedAt: z.string().nullable(),
  }),
  search: z.object({
    searchesAllTime: z.number().int().nonnegative(),
    searchesLast7Days: z.number().int().nonnegative(),
    searchesLast30Days: z.number().int().nonnegative(),
    noResultSearchesLast30Days: z.number().int().nonnegative(),
    noResultRatePercentLast30Days: z.number().finite().min(0).max(100).nullable(),
    searchersLast30Days: z.number().int().nonnegative(),
    generatorResultHitsLast30Days: z.number().int().nonnegative(),
    subscriberResultHitsLast30Days: z.number().int().nonnegative(),
    ownerResultHitsLast30Days: z.number().int().nonnegative(),
    trackingStartedAt: z.string().nullable(),
    lastSearchAt: z.string().nullable(),
  }),
});

const platformAdminPerformanceProcedure = authenticatedProcedure.use(({ ctx, next }) => {
  if (
    ctx.user.role !== "admin" ||
    ctx.user.accountStatus !== "active" ||
    !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "")
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "دور المنصة الحالي لا يملك صلاحية عرض قياسات الأداء.",
    });
  }

  return next({ ctx });
});

export const adminPerformanceRouter = router({
  performanceMetrics: platformAdminPerformanceProcedure.query(async () => {
    const { data, error } = await supabaseAdmin().rpc("powerhub_admin_get_performance_metrics");

    if (error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "تعذر تحميل قياسات قاعدة البيانات. تحقق من توفر ترحيل قياسات الأداء.",
      });
    }

    const parsed = performanceMetricsSchema.safeParse(data);
    if (!parsed.success) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "أعاد مصدر قياسات الأداء بيانات غير مطابقة للعقد المتوقع.",
      });
    }

    return parsed.data;
  }),
  activityMetrics: platformAdminPerformanceProcedure.query(async () => {
    const { data, error } = await supabaseAdmin().rpc("powerhub_admin_get_activity_metrics");
    if (error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "تعذر تحميل إحصاءات البحث وتوثيق الدفع. تحقق من ترحيل إحصاءات النشاط.",
      });
    }
    const parsed = activityMetricsSchema.safeParse(data);
    if (!parsed.success) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "أعاد مصدر إحصاءات النشاط بيانات غير مطابقة للعقد المتوقع.",
      });
    }
    return parsed.data;
  }),
});
