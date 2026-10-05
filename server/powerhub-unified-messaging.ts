import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { supabaseAdmin } from "./supabase-admin";
import { requireSupabaseSiteRole, writeSupabaseAudit } from "./powerhub-supabase";

const channelSchema = z.enum(["sms", "whatsapp"]);
const sendTypeSchema = z.enum(["manual", "automatic", "scheduled"]);
const scheduleTypeSchema = z.enum(["none", "one_time", "weekly", "every_10_days", "every_15_days", "monthly", "custom"]);

function asTemplate(row: any) {
  return {
    id: Number(row.id), tenantId: Number(row.tenant_id), name: row.name, description: row.description,
    channel: row.channel, eventType: row.event_type, body: row.body, variables: row.variables ?? [],
    isActive: Boolean(row.is_active), version: Number(row.version), createdBy: row.created_by === null ? null : Number(row.created_by),
    updatedBy: row.updated_by === null ? null : Number(row.updated_by), createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  };
}

export const powerhubUnifiedMessagingRouter = router({
  templates: protectedProcedure.input(z.object({
    siteId: z.number().int().positive(),
    channel: channelSchema.optional(),
    eventType: z.string().trim().max(100).optional(),
  })).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
    const { data, error } = await supabaseAdmin().rpc("powerhub_unified_messaging_templates", {
      p_tenant_id: access.tenantId, p_channel: input.channel ?? null, p_event_type: input.eventType ?? null,
    });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل قوالب المراسلة الموحدة." });
    return (data ?? []).map(asTemplate);
  }),

  saveTemplate: protectedProcedure.input(z.object({
    siteId: z.number().int().positive(), id: z.number().int().positive().optional(),
    name: z.string().trim().min(2).max(120), description: z.string().trim().max(500).optional(),
    channel: channelSchema, eventType: z.string().trim().max(100).optional(),
    body: z.string().trim().min(1).max(4096), variables: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
    isActive: z.boolean().default(true),
  })).mutation(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
    const { data, error } = await supabaseAdmin().rpc("powerhub_unified_messaging_upsert_template", {
      p_tenant_id: access.tenantId, p_name: input.name, p_description: input.description ?? null,
      p_channel: input.channel, p_event_type: input.eventType ?? null, p_body: input.body,
      p_variables: input.variables, p_is_active: input.isActive, p_actor_user_id: ctx.user.id,
    });
    if (error) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر حفظ قالب المراسلة الموحدة." });
    const id = Number((data as Array<{ id: number }> | null)?.[0]?.id ?? 0);
    if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد قاعدة البيانات معرف القالب." });
    await writeSupabaseAudit({ userId: ctx.user.id, tenantId: access.tenantId, siteId: input.siteId, entityType: "message_template", entityId: String(id), action: "upsert", afterData: { ...input, id } });
    return { id };
  }),

  automations: protectedProcedure.input(z.object({ siteId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
    const { data, error } = await supabaseAdmin().rpc("powerhub_unified_messaging_automations", { p_tenant_id: access.tenantId, p_site_id: input.siteId });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أتمتة المراسلة." });
    return (data ?? []).map((row: any) => ({
      id: Number(row.id), tenantId: Number(row.tenant_id), siteId: row.site_id === null ? null : Number(row.site_id),
      templateId: Number(row.template_id), templateName: row.template_name, name: row.name, eventType: row.event_type,
      sendType: row.send_type, scheduleType: row.schedule_type,
      scheduleAnchorAt: row.schedule_anchor_at ? new Date(row.schedule_anchor_at) : null,
      timezone: row.timezone, audience: row.audience ?? {}, enabled: Boolean(row.enabled),
      createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
    }));
  }),

  saveAutomation: protectedProcedure.input(z.object({
    siteId: z.number().int().positive(), id: z.number().int().positive().optional(),
    templateId: z.number().int().positive(), name: z.string().trim().min(2).max(120),
    eventType: z.string().trim().max(100).optional(),
    sendType: sendTypeSchema, scheduleType: scheduleTypeSchema.default("none"),
    scheduleAnchorAt: z.date().optional(), timezone: z.string().trim().min(1).max(80).default("Asia/Gaza"),
    audience: z.object({ subscriberIds: z.array(z.number().int().positive()).max(5000).optional(), serviceStatus: z.enum(["active", "suspended", "disconnected"]).optional(), tags: z.array(z.string().trim().max(80)).max(50).optional() }).default({}),
    enabled: z.boolean().default(true),
  })).mutation(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
    if (input.sendType === "automatic" && (input.scheduleType !== "none" || input.scheduleAnchorAt)) throw new TRPCError({ code: "BAD_REQUEST", message: "الأتمتة الحدثية لا تحتاج إلى جدولة." });
    if (input.sendType === "scheduled" && (input.scheduleType === "none" || !input.scheduleAnchorAt)) throw new TRPCError({ code: "BAD_REQUEST", message: "الجدولة تحتاج إلى نوع وتاريخ بداية." });
    const { data, error } = await supabaseAdmin().rpc("powerhub_unified_messaging_upsert_automation", {
      p_tenant_id: access.tenantId, p_site_id: input.siteId, p_template_id: input.templateId, p_name: input.name,
      p_event_type: input.eventType ?? null, p_send_type: input.sendType, p_schedule_type: input.scheduleType,
      p_schedule_anchor_at: input.scheduleAnchorAt?.toISOString() ?? null, p_timezone: input.timezone,
      p_audience: input.audience, p_enabled: input.enabled, p_actor_user_id: ctx.user.id,
    });
    if (error) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر حفظ أتمتة المراسلة." });
    const id = Number((data as Array<{ id: number }> | null)?.[0]?.id ?? 0);
    if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد قاعدة البيانات معرف الأتمتة." });
    await writeSupabaseAudit({ userId: ctx.user.id, tenantId: access.tenantId, siteId: input.siteId, entityType: "message_automation", entityId: String(id), action: "upsert", afterData: { ...input, id } });
    return { id };
  }),

  sendManual: protectedProcedure.input(z.object({
    siteId: z.number().int().positive(), templateId: z.number().int().positive(),
    subscriberIds: z.array(z.number().int().positive()).min(1).max(500),
  })).mutation(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageMessaging");
    const admin = supabaseAdmin();
    const { data: template, error: templateError } = await admin.from("powerhub_message_templates")
      .select("id, tenant_id, channel, body, is_active").eq("id", input.templateId).eq("tenant_id", access.tenantId).maybeSingle();
    if (templateError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل قالب الرسالة." });
    if (!template || !template.is_active) throw new TRPCError({ code: "NOT_FOUND", message: "قالب الرسالة غير متاح ضمن مساحة الشركة." });
    if (template.channel !== "sms") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الإرسال اليدوي متاح حالياً عبر SMS؛ قناة WhatsApp ستُفعّل بعد اعتماد موصل الإرسال." });
    const { data: subscribers, error: subscribersError } = await admin.from("subscribers")
      .select("id, phone, full_name, subscriber_no").eq("tenant_id", access.tenantId).eq("site_id", input.siteId).in("id", input.subscriberIds);
    if (subscribersError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المشتركين المحددين." });
    const byId = new Map((subscribers ?? []).map(s => [Number(s.id), s]));
    if (byId.size !== new Set(input.subscriberIds).size) throw new TRPCError({ code: "NOT_FOUND", message: "بعض المشتركين المحددين خارج نطاق الفرع." });
    const operationKey = `manual:${ctx.user.id}:${crypto.randomUUID()}`;
    const rows = input.subscriberIds.map(id => {
      const s = byId.get(id)!;
      const renderedText = template.body
        .replace(/{{\\s*subscriber_name\\s*}}/g, s.full_name ?? "")
        .replace(/{{\\s*subscriber_no\\s*}}/g, s.subscriber_no ?? "");
      return { tenant_id: access.tenantId, subscriber_id: id, channel: "sms", event_type: "manual", recipient: s.phone,
        status: "pending", send_type: "manual", schedule_type: "none",
        template_id: Number(template.id), payload: { renderedText, queuedBy: "manual_unified", operationKey } };
    });
    const { data: inserted, error } = await admin.from("notification_messages").insert(rows).select("id");
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إدخال الرسائل إلى طابور الإرسال." });
    const results: Array<{ notificationId: number; status: string; error?: string }> = [];
    for (const row of inserted ?? []) {
      try { const result = await (await import("./notification-worker")).processNotificationById(Number(row.id), ctx.user.id); results.push({ notificationId: Number(row.id), status: result.status, error: result.error }); }
      catch (error) { results.push({ notificationId: Number(row.id), status: "failed", error: error instanceof Error ? error.message : "تعذر إرسال الرسالة." }); }
    }
    await writeSupabaseAudit({ userId: ctx.user.id, tenantId: access.tenantId, siteId: input.siteId, entityType: "message_campaign", entityId: operationKey, action: "send_manual", metadata: { requested: input.subscriberIds.length, queued: rows.length, submitted: results.filter(r => r.status === "submitted").length, failed: results.filter(r => r.status === "failed").length } });
    return { operationKey, requested: input.subscriberIds.length, submitted: results.filter(r => r.status === "submitted").length, failed: results.filter(r => r.status === "failed").length, results };
  }),

  overview: protectedProcedure.input(z.object({ siteId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"], "manageMessaging");
    const [templates, automations, queue] = await Promise.all([
      supabaseAdmin().rpc("powerhub_unified_messaging_templates", { p_tenant_id: access.tenantId, p_channel: null, p_event_type: null }),
      supabaseAdmin().rpc("powerhub_unified_messaging_automations", { p_tenant_id: access.tenantId, p_site_id: input.siteId }),
      supabaseAdmin().from("notification_messages").select("status,send_type,schedule_type,channel,event_type").eq("tenant_id", access.tenantId).eq("subscriber_id", null).limit(0),
    ]);
    if (templates.error || automations.error || queue.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل ملخص نظام المراسلة." });
    return {
      templates: templates.data?.length ?? 0, automations: automations.data?.length ?? 0,
      enabledAutomations: (automations.data ?? []).filter((a: any) => a.enabled).length,
    };
  }),
});
