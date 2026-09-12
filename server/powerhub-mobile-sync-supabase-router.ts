import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { supabaseAdmin } from "./supabase-admin";
import { approveAndIssueMobileReadingSupabase } from "./powerhub-mobile-approval-supabase";
import {
  requireSupabaseSiteRole,
  getSupabaseSite,
  writeSupabaseAudit,
} from "./powerhub-supabase";
import { processNotificationById } from "./notification-worker";
import { rolesWith, type PowerCapability } from "../shared/powerhub-rbac";

const createRoles = rolesWith("issueInvoices");

const siteScoped = z.object({ siteId: z.number().int().positive() });
const mobileSyncReadingsInput = siteScoped.extend({
  userId: z.number().int().positive().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(10).max(100).default(25),
});
const mobileSyncReadingDetailInput = siteScoped.extend({ readingId: z.number().int().positive() });
const mobileSyncApproveInput = z.object({
  siteId: z.number().int().positive(),
  readingId: z.number().int().positive(),
  baseVersion: z.number().int().positive(),
  sendNow: z.boolean().default(true),
});
const mobileSyncBulkApprovalInput = siteScoped.extend({
  userId: z.number().int().positive().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(100),
  sendNow: z.boolean().default(true),
});

async function getMobileReadingScope(userId: number, siteId: number, readingId: number, capability: PowerCapability) {
  const access = await requireSupabaseSiteRole(userId, siteId, ["owner", "manager", "accountant"], capability);
  const admin = supabaseAdmin();
  const [{ data: audit, error: auditError }, { data: reading, error: readingError }] = await Promise.all([
    admin.from("audit_logs").select("user_id, created_at").eq("tenant_id", access.tenantId).eq("site_id", siteId)
      .eq("entity_type", "meter_reading").eq("action", "mobile_create").eq("entity_id", String(readingId)).maybeSingle(),
    admin.from("meter_readings").select("id, version_no, subscriber_id, previous_reading_value, reading_value, consumption_kwh, reading_at, status, capture_method, notes")
      .eq("tenant_id", access.tenantId).eq("id", readingId).maybeSingle(),
  ]);
  if (auditError || readingError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل القراءة الميدانية من Supabase." });
  if (!audit?.user_id || !reading) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة الميدانية غير موجودة ضمن الفرع المحدد." });
  const { data: subscriber, error: subscriberError } = await admin.from("subscribers")
    .select("id, full_name, subscriber_no").eq("tenant_id", access.tenantId).eq("site_id", siteId).eq("id", reading.subscriber_id).maybeSingle();
  if (subscriberError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل بيانات المشترك من Supabase." });
  if (!subscriber) throw new TRPCError({ code: "NOT_FOUND", message: "القراءة الميدانية غير موجودة ضمن الفرع المحدد." });
  return { access, audit, reading, subscriber };
}

async function dispatchQueuedNotifications(notificationIds: number[]) {
  return Promise.all(notificationIds.map(async (notificationId) => {
    try {
      return { notificationId, ...await processNotificationById(notificationId) };
    } catch (error) {
      return {
        notificationId,
        status: "failed" as const,
        error: error instanceof Error ? error.message : "تعذر إرسال إشعار الفاتورة.",
      };
    }
  }));
}

async function approveOne(input: z.infer<typeof mobileSyncApproveInput>, userId: number) {
  const scope = await getMobileReadingScope(userId, input.siteId, input.readingId, "approveReadings");
  await requireSupabaseSiteRole(userId, input.siteId, ["owner", "manager", "accountant"], "issueInvoices");
  const site = await getSupabaseSite(input.siteId);
  const readingAt = new Date(scope.reading.reading_at);
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + Math.max(1, Math.min(90, site.invoiceDueDays ?? 14)));
  const result = await approveAndIssueMobileReadingSupabase({
    tenantId: scope.access.tenantId,
    siteId: input.siteId,
    userId,
    readingId: input.readingId,
    baseVersion: input.baseVersion,
    dueDate,
    billingPeriod: readingAt.toISOString().slice(0, 7),
    discountAmount: 0,
  });
  const deliveries = input.sendNow === false
    ? []
    : await dispatchQueuedNotifications(result.notificationIds);
  const notificationMode = input.sendNow === false ? "deferred" : "immediate";
  await writeSupabaseAudit({
    userId,
    tenantId: scope.access.tenantId,
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
    invoiceId: result.invoiceId,
    invoiceNo: result.invoiceNo,
    totalAmount: result.totalAmount,
    alreadyProcessed: result.alreadyProcessed,
    notificationMode,
    deliveries,
  };
}

export const powerhubMobileSyncSupabaseRouter = router({
  summary: protectedProcedure.input(siteScoped.extend({ from: z.string().datetime().optional(), to: z.string().datetime().optional() })).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
    const from = input.from ? new Date(input.from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = input.to ? new Date(input.to) : new Date();
    const { data, error } = await supabaseAdmin().from("mobile_sync_events")
      .select("user_id, status, synced_count, retryable_count, needs_review_count, occurred_at")
      .eq("tenant_id", access.tenantId).eq("site_id", input.siteId)
      .gte("occurred_at", from.toISOString()).lte("occurred_at", to.toISOString());
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل ملخص المزامنة الميدانية من Supabase." });
    const rows = data ?? [];
    const lastEventAt = rows.reduce<string | null>((latest, row) => !latest || row.occurred_at > latest ? row.occurred_at : latest, null);
    return {
      cycles: rows.length,
      syncedReadings: rows.reduce((total, row) => total + Number(row.synced_count ?? 0), 0),
      retryableReadings: rows.reduce((total, row) => total + Number(row.retryable_count ?? 0), 0),
      needsReviewReadings: rows.reduce((total, row) => total + Number(row.needs_review_count ?? 0), 0),
      failedEvents: rows.filter((row) => row.status === "failed" || row.status === "needs_review").length,
      activeTechnicians: new Set(rows.map((row) => Number(row.user_id))).size,
      lastEventAt: lastEventAt ? new Date(lastEventAt) : null,
    };
  }),
  list: protectedProcedure.input(siteScoped.extend({ status: z.enum(["success", "partial", "retryable", "needs_review", "failed"]).optional(), userId: z.number().int().positive().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(10).max(100).default(25) })).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
    let query = supabaseAdmin().from("mobile_sync_events")
      .select("id, user_id, event_type, status, synced_count, retryable_count, needs_review_count, error_code, error_message, app_version, device_label, occurred_at")
      .eq("tenant_id", access.tenantId).eq("site_id", input.siteId);
    if (input.status) query = query.eq("status", input.status);
    if (input.userId) query = query.eq("user_id", input.userId);
    if (input.from) query = query.gte("occurred_at", input.from);
    if (input.to) query = query.lte("occurred_at", input.to);
    const { data, error } = await query.order("occurred_at", { ascending: false }).range((input.page - 1) * input.pageSize, input.page * input.pageSize - 1);
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أحداث المزامنة الميدانية من Supabase." });
    const userIds = Array.from(new Set((data ?? []).map((row) => Number(row.user_id))));
    const { data: usersData, error: usersError } = userIds.length ? await supabaseAdmin().from("users").select("id, name, email").in("id", userIds) : { data: [], error: null };
    if (usersError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل منفذي المزامنة من Supabase." });
    const usersById = new Map((usersData ?? []).map((user) => [Number(user.id), user]));
    return (data ?? []).map((row) => ({
      id: Number(row.id), eventType: row.event_type as "sync_cycle" | "sync_error", status: row.status as "success" | "partial" | "retryable" | "needs_review" | "failed",
      syncedCount: Number(row.synced_count), retryableCount: Number(row.retryable_count), needsReviewCount: Number(row.needs_review_count), errorCode: row.error_code,
      errorMessage: row.error_message, appVersion: row.app_version, deviceLabel: row.device_label, occurredAt: new Date(row.occurred_at),
      userId: Number(row.user_id), userName: usersById.get(Number(row.user_id))?.name ?? null, userEmail: usersById.get(Number(row.user_id))?.email ?? null,
    }));
  }),
  readings: protectedProcedure.input(mobileSyncReadingsInput).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
    let auditQuery = supabaseAdmin().from("audit_logs").select("entity_id, user_id, created_at")
      .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("entity_type", "meter_reading").eq("action", "mobile_create");
    if (input.userId) auditQuery = auditQuery.eq("user_id", input.userId);
    if (input.from) auditQuery = auditQuery.gte("created_at", input.from);
    if (input.to) auditQuery = auditQuery.lte("created_at", input.to);
    const { data: auditRows, error: auditError } = await auditQuery.order("created_at", { ascending: false }).range((input.page - 1) * input.pageSize, input.page * input.pageSize - 1);
    if (auditError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تدقيق القراءات الميدانية من Supabase." });
    const readingIds = (auditRows ?? []).map((row) => Number(row.entity_id)).filter(Number.isInteger);
    if (!readingIds.length) return [];
    const [readingsResult, subscribersResult] = await Promise.all([
      supabaseAdmin().from("meter_readings").select("id, version_no, subscriber_id, previous_reading_value, reading_value, reading_at, status").eq("tenant_id", access.tenantId).in("id", readingIds),
      supabaseAdmin().from("subscribers").select("id, full_name, subscriber_no").eq("tenant_id", access.tenantId).eq("site_id", input.siteId),
    ]);
    if (readingsResult.error || subscribersResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تفاصيل القراءات الميدانية من Supabase." });
    const readingsById = new Map((readingsResult.data ?? []).map((reading) => [Number(reading.id), reading]));
    const subscribersById = new Map((subscribersResult.data ?? []).map((subscriber) => [Number(subscriber.id), subscriber]));
    return (auditRows ?? []).flatMap((audit) => {
      const reading = readingsById.get(Number(audit.entity_id));
      const subscriber = reading ? subscribersById.get(Number(reading.subscriber_id)) : undefined;
      return reading && subscriber ? [{
        id: Number(reading.id), versionNo: Number(reading.version_no), subscriberName: subscriber.full_name, subscriberNo: subscriber.subscriber_no,
        previousReading: Number(reading.previous_reading_value), currentReading: Number(reading.reading_value), readingAt: new Date(reading.reading_at),
        syncedAt: new Date(audit.created_at), status: reading.status, userId: audit.user_id === null ? null : Number(audit.user_id),
      }] : [];
    });
  }),
  readingDetail: protectedProcedure.input(mobileSyncReadingDetailInput).query(async ({ ctx, input }) => {
    const scope = await getMobileReadingScope(ctx.user.id, input.siteId, input.readingId, "viewAudit");
    const technicianResult = await supabaseAdmin().from("users").select("name, email").eq("id", scope.audit.user_id).maybeSingle();
    if (technicianResult.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل الفني المنفذ للقراءة من Supabase." });
    return {
      id: Number(scope.reading.id), versionNo: Number(scope.reading.version_no), subscriberId: Number(scope.subscriber.id), subscriberName: scope.subscriber.full_name, subscriberNo: scope.subscriber.subscriber_no,
      previousReading: Number(scope.reading.previous_reading_value), currentReading: Number(scope.reading.reading_value), consumptionKwh: Number(scope.reading.consumption_kwh),
      readingAt: new Date(scope.reading.reading_at), syncedAt: new Date(scope.audit.created_at), status: scope.reading.status as "draft" | "pending_review" | "approved" | "rejected",
      captureMethod: scope.reading.capture_method, notes: scope.reading.notes, technicianName: technicianResult.data?.name ?? null, technicianEmail: technicianResult.data?.email ?? null,
    };
  }),
  approveAndIssue: protectedProcedure.input(mobileSyncApproveInput).mutation(async ({ ctx, input }) => approveOne(input, ctx.user.id)),
  approveAllAndIssue: protectedProcedure.input(mobileSyncBulkApprovalInput).mutation(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "approveReadings");
    await requireSupabaseSiteRole(ctx.user.id, input.siteId, createRoles, "issueInvoices");
    let auditQuery = supabaseAdmin().from("audit_logs").select("entity_id, created_at")
      .eq("tenant_id", access.tenantId).eq("site_id", input.siteId).eq("entity_type", "meter_reading").eq("action", "mobile_create");
    if (input.from) auditQuery = auditQuery.gte("created_at", input.from);
    if (input.to) auditQuery = auditQuery.lte("created_at", input.to);
    const { data: auditRows, error: auditError } = await auditQuery.order("created_at", { ascending: true }).limit(input.limit);
    if (auditError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل القراءات الميدانية للمراجعة من Supabase." });
    const uniqueIds = Array.from(new Set((auditRows ?? []).map((row) => Number(row.entity_id)).filter(Number.isInteger)));
    const results = [] as Array<Awaited<ReturnType<typeof approveOne>> | { readingId: number; status: "failed"; error: string }>;
    for (const readingId of uniqueIds) {
      const readingResult = await supabaseAdmin().from("meter_readings").select("version_no").eq("tenant_id", access.tenantId).eq("id", readingId).maybeSingle();
      if (readingResult.error || !readingResult.data) {
        results.push({ readingId, status: "failed", error: "القراءة الميدانية غير موجودة ضمن الفرع المحدد." });
        continue;
      }
      try {
        results.push(await approveOne({ siteId: input.siteId, readingId, baseVersion: Number(readingResult.data.version_no), sendNow: input.sendNow }, ctx.user.id));
      } catch (error) {
        results.push({ readingId, status: "failed", error: error instanceof TRPCError ? error.message : error instanceof Error ? error.message : "تعذر اعتماد القراءة." });
      }
    }
    return { requested: uniqueIds.length, approved: results.filter((result) => !((result as { status?: string }).status === "failed")).length, failed: results.filter((result) => (result as { status?: string }).status === "failed").length, results };
  }),
  technicians: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "viewAudit");
    const { data: profiles, error: profilesError } = await supabaseAdmin().from("staff_profiles").select("user_id")
      .eq("tenant_id", access.tenantId).eq("is_active", true).or(`site_id.eq.${input.siteId},site_id.is.null`);
    if (profilesError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تعيينات الفنيين من Supabase." });
    const userIds = Array.from(new Set((profiles ?? []).map((profile) => Number(profile.user_id))));
    if (!userIds.length) return [];
    const { data, error } = await supabaseAdmin().from("users").select("id, name, email").in("id", userIds);
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل قائمة الفنيين من Supabase." });
    return (data ?? []).map((user) => ({ id: Number(user.id), name: user.name, email: user.email }));
  }),
});
