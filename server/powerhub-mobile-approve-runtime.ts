import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure } from "./_core/trpc";
import { supabaseAdmin } from "./supabase-admin";
import { approveAndIssueMobileReadingSupabase } from "./powerhub-mobile-approval-supabase";
import { getSupabaseSite, requireSupabaseSiteRole, writeSupabaseAudit } from "./powerhub-supabase";
import { processNotificationById } from "./notification-worker";

const mobileSyncApproveInput = z.object({
  siteId: z.number().int().positive(),
  readingId: z.number().int().positive(),
  baseVersion: z.number().int().positive(),
  sendNow: z.boolean().default(true),
});

async function dispatchQueuedNotifications(notificationIds: number[], actorUserId: number) {
  return Promise.all(notificationIds.map(async (notificationId) => {
    try {
      return { notificationId, ...await processNotificationById(notificationId, actorUserId) };
    } catch (error) {
      return {
        notificationId,
        status: "failed" as const,
        error: error instanceof Error ? error.message : "تعذر إرسال إشعار الفاتورة.",
      };
    }
  }));
}

export const approveAndIssueMobileReadingRuntime = protectedProcedure
  .input(mobileSyncApproveInput)
  .mutation(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "approveReadings");
    await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "issueInvoices");

    const admin = supabaseAdmin();
    const { data: reading, error: readingError } = await admin.from("meter_readings")
      .select("id, subscriber_id, reading_at, status")
      .eq("tenant_id", access.tenantId)
      .eq("id", input.readingId)
      .maybeSingle();
    if (readingError) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل القراءة من Supabase." });
    }
    if (!reading) {
      throw new TRPCError({ code: "NOT_FOUND", message: "القراءة غير موجودة ضمن الفرع المحدد." });
    }

    const subscriberResult = await admin.from("subscribers")
      .select("id")
      .eq("tenant_id", access.tenantId)
      .eq("site_id", input.siteId)
      .eq("id", reading.subscriber_id)
      .maybeSingle();
    if (subscriberResult.error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من نطاق المشترك في Supabase." });
    }
    if (!subscriberResult.data) {
      throw new TRPCError({ code: "NOT_FOUND", message: "القراءة الميدانية غير موجودة ضمن الفرع المحدد." });
    }

    const site = await getSupabaseSite(input.siteId);
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + Math.max(1, Math.min(90, site.invoiceDueDays ?? 14)));
    const result = await approveAndIssueMobileReadingSupabase({
      tenantId: access.tenantId,
      siteId: input.siteId,
      userId: ctx.user.id,
      readingId: input.readingId,
      baseVersion: input.baseVersion,
      dueDate,
      billingPeriod: new Date(reading.reading_at).toISOString().slice(0, 7),
      discountAmount: 0,
    });

    const deliveries = input.sendNow === false
      ? []
      : await dispatchQueuedNotifications(result.notificationIds, ctx.user.id);
    const notificationMode = input.sendNow === false ? "deferred" : "immediate";

    await writeSupabaseAudit({
      userId: ctx.user.id,
      tenantId: access.tenantId,
      siteId: input.siteId,
      entityType: "meter_reading",
      entityId: String(input.readingId),
      action: result.alreadyProcessed ? "mobile_approve_replay" : "mobile_approve_and_issue",
      metadata: {
        invoiceId: result.invoiceId,
        invoiceNo: result.invoiceNo,
        automaticInvoice: true,
        notificationMode,
        deliveryCount: deliveries.length,
        runtime: "supabase",
      },
    });

    return {
      id: result.invoiceId,
      invoiceNo: result.invoiceNo,
      totalAmount: result.totalAmount,
      alreadyProcessed: result.alreadyProcessed,
      notificationMode,
      deliveries,
    };
  });
