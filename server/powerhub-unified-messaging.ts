import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { supabaseAdmin } from "./supabase-admin";
import { requireSupabaseSiteRole, writeSupabaseAudit } from "./powerhub-supabase";
import { processNotificationQueueForTenant } from "./notification-worker";

const channelSchema = z.enum(["sms", "whatsapp"]);
const sendTypeSchema = z.enum(["manual", "automatic", "scheduled"]);
const scheduleTypeSchema = z.enum(["none", "one_time", "weekly", "every_10_days", "every_15_days", "monthly", "custom"]);
const eventTypeSchema = z.enum(["invoice_issued", "subscriber_created", "invoice_overdue", "payment_received", "service_alert"]);

function asTemplate(row: any) {
  return {
    id: Number(row.id), tenantId: Number(row.tenant_id), name: row.name, description: row.description,
    channel: row.channel, eventType: row.event_type, body: row.body, variables: row.variables ?? [],
    isActive: Boolean(row.is_active), version: Number(row.version), createdBy: row.created_by == null ? null : Number(row.created_by),
    updatedBy: row.updated_by == null ? null : Number(row.updated_by), createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  };
}

function render(body: string, values: Record<string, string | null | undefined>) {
  return body.replace(/{{\s*([a-z_]+)\s*}}/g, (_, key) => values[key] ?? "");
}

async function processNotificationIdsInBatches(
  tenantId: number,
  actorUserId: number,
  notificationIds: number[],
  heartbeat?: () => Promise<void>,
) {
  const all: Array<{ notificationId: number; status: "submitted" | "failed" | "skipped"; providerMessageId?: string | null; error?: string }> = [];
  for (let offset = 0; offset < notificationIds.length; offset += 50) {
    const batch = notificationIds.slice(offset, offset + 50);
    const result = await processNotificationQueueForTenant(tenantId, actorUserId, batch);
    all.push(...(result.results ?? []));
    if (heartbeat && offset + 50 < notificationIds.length) await heartbeat();
  }
  return {
    requested: notificationIds.length,
    submitted: all.filter((row) => row.status === "submitted").length,
    failed: all.filter((row) => row.status === "failed").length,
    skipped: all.filter((row) => row.status === "skipped").length,
    results: all,
  };
}

async function getPlatformActorId() {
  const { data, error } = await supabaseAdmin().from("users").select("id")
    .eq("account_status", "active").in("platform_role", ["platform_owner", "platform_admin"])
    .order("id", { ascending: true }).limit(1).maybeSingle();
  if (error || !data) throw new Error("لا يوجد منفذ منصة نشط لتشغيل أتمتة المراسلة.");
  return Number(data.id);
}

async function executeAutomation(automation: any, now: Date, actorUserId: number) {
  const admin = supabaseAdmin();
  let occ: { due: boolean; occurrence_at: string; occurrence_key: string };
  if (automation.send_type === "automatic") {
    occ = {
      due: true,
      occurrence_at: now.toISOString(),
      occurrence_key: `event:${automation.event_type}:${now.toISOString().slice(0, 10)}`,
    };
  } else {
    const occurrence = await admin.rpc("powerhub_unified_messaging_next_occurrence", {
      p_schedule_type: automation.schedule_type,
      p_schedule_anchor_at: automation.schedule_anchor_at,
      p_timezone: automation.timezone,
      p_now: now.toISOString(),
    });
    if (occurrence.error || !occurrence.data?.[0]?.due) return { status: "skipped", requested: 0, queued: 0, failed: 0, skipped: 0 };
    occ = occurrence.data[0];
  }
  const claim = await admin.rpc("powerhub_claim_unified_automation_run", {
    p_tenant_id: Number(automation.tenant_id), p_site_id: Number(automation.site_id),
    p_automation_id: Number(automation.id), p_occurrence_key: String(occ.occurrence_key),
  });
  if (claim.error) throw new Error("تعذر حجز دورة الأتمتة.");
  if (claim.data !== true && !(Array.isArray(claim.data) && claim.data[0] === true)) return { status: "skipped", requested: 0, queued: 0, failed: 0, skipped: 0 };

  const template = automation.template;
  if (!template?.is_active || template.channel !== "sms") {
    await admin.rpc("powerhub_finish_unified_automation_run", {
      p_tenant_id: Number(automation.tenant_id), p_automation_id: Number(automation.id),
      p_occurrence_key: String(occ.occurrence_key), p_status: "skipped",
      p_requested: 0, p_queued: 0, p_skipped: 0, p_failed: 0, p_error: "TEMPLATE_DISABLED",
    });
    return { status: "skipped", requested: 0, queued: 0, failed: 0, skipped: 0 };
  }

  const tenantId = Number(automation.tenant_id);
  const siteId = Number(automation.site_id);
  const eventType = String(automation.event_type);
  const audience = automation.audience ?? {};
  const trigger = automation.trigger_config ?? {};
  const notificationIds: number[] = [];
  let skipped = 0;
  let requestedCount = 0;
  const baseQuery = admin.from("subscribers")
    .select("id,full_name,subscriber_no,phone,service_status,created_at")
    .eq("tenant_id", tenantId).eq("site_id", siteId).is("archived_at", null);

  if (eventType === "payment_received") {
    const { data: payments, error: paymentsError } = await admin.from("payments")
      .select("id,subscriber_id,invoice_id,amount,paid_at")
      .eq("tenant_id", tenantId).eq("site_id", siteId).eq("status", "completed")
      .gte("created_at", new Date(automation.created_at).toISOString()).order("id", { ascending: true }).limit(500);
    if (paymentsError) throw new Error("تعذر تحميل دفعات الأتمتة.");
    requestedCount = payments?.length ?? 0;
    for (const payment of payments ?? []) {
      const { data: subscriber } = await admin.from("subscribers").select("id,full_name,subscriber_no,phone").eq("id", Number(payment.subscriber_id)).eq("tenant_id", tenantId).eq("site_id", siteId).maybeSingle();
      if (!subscriber) { skipped++; continue; }
      const { data: invoice } = payment.invoice_id
        ? await admin.from("invoices").select("id,invoice_no,billing_period,total_amount,balance_due,due_date").eq("id",Number(payment.invoice_id)).eq("tenant_id",tenantId).eq("site_id",siteId).maybeSingle()
        : { data: null };
      const operationKey = `automation:${automation.id}:payment:${payment.id}`;
      const values = {
        subscriber_name: subscriber.full_name ?? "", subscriber_no: subscriber.subscriber_no ?? "",
        invoice_no: invoice?.invoice_no ?? "", billing_period: invoice?.billing_period ?? "",
        total_amount: invoice?.total_amount == null ? "" : String(invoice.total_amount),
        balance_due: invoice?.balance_due == null ? "" : String(invoice.balance_due),
        due_date: invoice?.due_date ? new Date(invoice.due_date).toLocaleDateString("ar-PS") : "",
      };
      const inserted = await admin.from("notification_messages").insert({
        tenant_id: tenantId, subscriber_id: Number(subscriber.id), invoice_id: invoice?.id ?? null,
        channel: "sms", event_type: "payment_received", recipient: subscriber.phone ?? "", status: "pending",
        send_type: automation.send_type, schedule_type: automation.schedule_type, template_id: Number(template.id),
        automation_id: Number(automation.id), operation_key: operationKey,
        payload: { renderedText: render(template.body, values), operationKey, automationId: Number(automation.id) },
      }).select("id").maybeSingle();
      if (inserted.error) {
        if (String(inserted.error.message).toLowerCase().includes("duplicate")) { skipped++; continue; }
        throw new Error("تعذر إدخال إيصال الدفع إلى الطابور.");
      }
      if (inserted.data?.id) notificationIds.push(Number(inserted.data.id));
    }
  } else {
    let subscribersQuery = baseQuery;
    if (Array.isArray(audience.subscriberIds) && audience.subscriberIds.length) subscribersQuery = subscribersQuery.in("id", audience.subscriberIds.map(Number));
    if (audience.serviceStatus) subscribersQuery = subscribersQuery.eq("service_status", audience.serviceStatus);
    let subscribers = (await subscribersQuery.limit(500)).data ?? [];
    requestedCount = subscribers.length;

    if (eventType === "subscriber_created") {
      subscribers = subscribers.filter((s: any) => new Date(s.created_at) >= new Date(automation.created_at));
    }
    if (eventType === "invoice_issued") {
      // Invoice issuance already has the canonical atomic trigger. Do not create a second message here.
      subscribers = [];
    }

    for (const subscriber of subscribers) {
      let invoice: any = null;
      if (eventType === "invoice_overdue") {
        const { data } = await admin.from("invoices")
          .select("id,invoice_no,billing_period,total_amount,balance_due,due_date,status")
          .eq("tenant_id", tenantId).eq("site_id", siteId).eq("subscriber_id", Number(subscriber.id))
          .in("status", ["issued","partially_paid","overdue"]).gt("balance_due", 0)
          .lte("due_date", now.toISOString()).order("due_date", { ascending: false }).limit(1).maybeSingle();
        invoice = data;
        const afterDueDays = Number(trigger.afterDueDays ?? 0);
        if (!invoice || (now.getTime() - new Date(invoice.due_date).getTime()) < afterDueDays * 86400000) { skipped++; continue; }
        if (trigger.minBalance != null && Number(invoice.balance_due) < Number(trigger.minBalance)) { skipped++; continue; }
      }
      const operationKey = eventType === "invoice_overdue"
        ? `automation:${automation.id}:invoice:${invoice.id}:${occ.occurrence_key}`
        : `automation:${automation.id}:subscriber:${subscriber.id}`;
      const values = {
        subscriber_name: subscriber.full_name ?? "", subscriber_no: subscriber.subscriber_no ?? "",
        invoice_no: invoice?.invoice_no ?? "", billing_period: invoice?.billing_period ?? "",
        total_amount: invoice?.total_amount == null ? "" : String(invoice.total_amount),
        balance_due: invoice?.balance_due == null ? "" : String(invoice.balance_due),
        due_date: invoice?.due_date ? new Date(invoice.due_date).toLocaleDateString("ar-PS") : "",
      };
      let textBody = render(template.body, values);
      if (textBody.includes("{{invoice_link}}") || textBody.includes("{{portal_link}}")) {
        const base = await admin.rpc("powerhub_public_base_url");
        if (base.error || !base.data) throw new Error("PUBLIC_BASE_URL_NOT_CONFIGURED");
        if (invoice?.id) {
          const token = crypto.randomBytes(24).toString("base64url");
          const link = await admin.rpc("powerhub_create_invoice_share_link", {
            p_tenant_id: tenantId, p_site_id: siteId, p_user_id: actorUserId, p_invoice_id: Number(invoice.id),
            p_token_hash: crypto.createHash("sha256").update(token).digest("hex"), p_token_preview: token.slice(0,8), p_expires_at: null,
          });
          if (link.error) throw new Error("تعذر إنشاء رابط الفاتورة.");
          textBody = textBody.replace(/{{\\s*invoice_link\\s*}}/g, `${base.data}/invoice/${token}`);
        }
        const portal = await admin.from("site_portal_settings").select("portal_code").eq("tenant_id",tenantId).eq("site_id",siteId).maybeSingle();
        textBody = textBody.replace(/{{\\s*portal_link\\s*}}/g, portal.data?.portal_code ? `${base.data}/portal?g=${portal.data.portal_code}` : "");
      }
      const inserted = await admin.from("notification_messages").insert({
        tenant_id: tenantId, subscriber_id: Number(subscriber.id), invoice_id: invoice?.id ?? null,
        channel: "sms", event_type: eventType === "subscriber_created" ? "subscriber_reference" : eventType,
        recipient: subscriber.phone ?? "", status: "pending", send_type: automation.send_type,
        schedule_type: automation.schedule_type, template_id: Number(template.id), automation_id: Number(automation.id),
        operation_key: operationKey,
        payload: { renderedText: textBody, operationKey, automationId: Number(automation.id), occurrenceKey: occ.occurrence_key },
      }).select("id").maybeSingle();
      if (inserted.error) {
        if (String(inserted.error.message).toLowerCase().includes("duplicate")) { skipped++; continue; }
        throw new Error("تعذر إدخال رسالة الأتمتة إلى الطابور.");
      }
      if (inserted.data?.id) notificationIds.push(Number(inserted.data.id));
    }
  }

  const result = notificationIds.length
    ? await processNotificationIdsInBatches(
    tenantId,
    actorUserId,
    notificationIds,
    async () => {
      const heartbeat = await admin.rpc("powerhub_touch_unified_automation_run", {
        p_tenant_id: Number(automation.tenant_id),
        p_automation_id: Number(automation.id),
        p_occurrence_key: occ.occurrence_key,
      });
      if (heartbeat.error || heartbeat.data !== true) {
        throw new Error("تعذر تجديد قفل تنفيذ أتمتة المراسلة.");
      }
    },
  )
    : { submitted: 0, failed: 0, skipped: 0 };
  await admin.rpc("powerhub_finish_unified_automation_run", {
    p_tenant_id: tenantId, p_automation_id: Number(automation.id), p_occurrence_key: String(occ.occurrence_key),
    p_status: result.failed ? "partial" : "completed", p_requested: requestedCount, p_queued: notificationIds.length,
    p_skipped: skipped + result.skipped, p_failed: result.failed, p_error: null,
  });
  await writeSupabaseAudit({
    userId: actorUserId, tenantId, siteId, entityType: "message_automation", entityId: String(automation.id),
    action: "execute", metadata: { occurrenceKey: occ.occurrence_key, requested: requestedCount, queued: notificationIds.length, submitted: result.submitted, failed: result.failed, skipped },
  });
  return { status: result.failed ? "partial" : "completed", requested: requestedCount, queued: notificationIds.length, failed: result.failed, skipped: skipped + result.skipped };
}

export async function processUnifiedMessagingAutomations(now = new Date()) {
  const admin = supabaseAdmin();
  await admin.rpc("powerhub_reclaim_stale_sms_notifications", { p_limit: 200 });
  const { data: rows, error } = await admin.from("powerhub_message_automations")
    .select("id,tenant_id,site_id,template_id,name,event_type,send_type,schedule_type,schedule_anchor_at,timezone,audience,trigger_config,created_at")
    .eq("enabled", true).is("archived_at", null);
  if (error) throw new Error("تعذر تحميل أتمتة المراسلة المفعلة.");
  const actor = await getPlatformActorId();
  const ids = (rows ?? []).filter((r: any) => r.site_id != null);
  const results = [];
  for (const row of ids) {
    const { data: template } = await admin.from("powerhub_message_templates").select("id,body,channel,is_active").eq("id", Number(row.template_id)).maybeSingle();
    try {
      results.push({ automationId: Number(row.id), ...(await executeAutomation({ ...row, template }, now, actor)) });
    } catch (error) {
      results.push({ automationId: Number(row.id), status: "failed", error: error instanceof Error ? error.message : "فشل تنفيذ الأتمتة." });
    }
  }
  return { automations: results.length, results };
}

export const powerhubUnifiedMessagingRouter = router({
  templates: protectedProcedure.input(z.object({
    siteId: z.number().int().positive(), channel: channelSchema.optional(), eventType: eventTypeSchema.optional(),
  })).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner","manager","accountant","viewer"], "manageMessaging");
    const { data, error } = await supabaseAdmin().rpc("powerhub_unified_messaging_templates", {
      p_tenant_id: access.tenantId, p_channel: input.channel ?? null, p_event_type: input.eventType ?? null,
    });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل قوالب المراسلة الموحدة." });
    return (data ?? []).map(asTemplate);
  }),

  saveTemplate: protectedProcedure.input(z.object({
    siteId: z.number().int().positive(), id: z.number().int().positive().optional(),
    name: z.string().trim().min(2).max(120), description: z.string().trim().max(500).optional(),
    channel: channelSchema, eventType: eventTypeSchema.optional(), body: z.string().trim().min(1).max(4096),
    variables: z.array(z.string().trim().min(1).max(80)).max(50).default([]), isActive: z.boolean().default(true),
    invoiceStyle: z.enum(["details","portal_link"]).optional(),
  })).mutation(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
    const { data, error } = await supabaseAdmin().rpc("powerhub_unified_messaging_upsert_template_v2", {
      p_id: input.id ?? null, p_tenant_id: access.tenantId, p_name: input.name, p_description: input.description ?? null,
      p_channel: input.channel, p_event_type: input.eventType ?? null, p_body: input.body, p_variables: input.variables,
      p_is_active: input.isActive, p_actor_user_id: ctx.user.id, p_invoice_style: input.invoiceStyle ?? null,
    });
    if (error) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذر حفظ قالب المراسلة الموحدة." });
    const id = Number(Array.isArray(data) ? data[0]?.powerhub_unified_messaging_upsert_template_v2 ?? data[0]?.id : data);
    if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد قاعدة البيانات معرف القالب." });
    await writeSupabaseAudit({ userId: ctx.user.id, tenantId: access.tenantId, siteId: input.siteId, entityType: "message_template", entityId: String(id), action: input.id ? "update" : "create", afterData: { id, channel: input.channel, eventType: input.eventType, isActive: input.isActive, invoiceStyle: input.invoiceStyle ?? null } });
    return { id };
  }),

  automations: protectedProcedure.input(z.object({ siteId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner","manager","accountant"], "manageMessaging");
    const { data, error } = await supabaseAdmin().rpc("powerhub_unified_messaging_automations", { p_tenant_id: access.tenantId, p_site_id: input.siteId });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل أتمتة المراسلة." });
    return (data ?? []).map((row: any) => ({ id:Number(row.id), tenantId:Number(row.tenant_id), siteId:row.site_id==null?null:Number(row.site_id), templateId:Number(row.template_id), templateName:row.template_name, name:row.name, eventType:row.event_type, sendType:row.send_type, scheduleType:row.schedule_type, scheduleAnchorAt:row.schedule_anchor_at?new Date(row.schedule_anchor_at):null, timezone:row.timezone, audience:row.audience??{}, triggerConfig:row.trigger_config??{}, enabled:Boolean(row.enabled), archivedAt:row.archived_at?new Date(row.archived_at):null, createdAt:new Date(row.created_at), updatedAt:new Date(row.updated_at) }));
  }),

  saveAutomation: protectedProcedure.input(z.object({
    siteId:z.number().int().positive(), id:z.number().int().positive().optional(), templateId:z.number().int().positive(), name:z.string().trim().min(2).max(120),
    eventType:eventTypeSchema, sendType:sendTypeSchema, scheduleType:scheduleTypeSchema.default("none"), scheduleAnchorAt:z.date().optional(),
    timezone:z.string().trim().min(1).max(80).default("Asia/Gaza"),
    audience:z.object({subscriberIds:z.array(z.number().int().positive()).max(500).optional(),serviceStatus:z.enum(["active","suspended","disconnected"]).optional(),tags:z.array(z.string().trim().max(80)).max(50).optional()}).default({}),
    triggerConfig:z.object({afterDueDays:z.number().int().min(0).max(90).optional(),minBalance:z.number().min(0).optional()}).default({}), enabled:z.boolean().default(true),
  })).mutation(async ({ctx,input})=>{
    const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner"],"manageMessaging");
    if(input.sendType==="manual") throw new TRPCError({code:"BAD_REQUEST",message:"الإرسال اليدوي لا يُحفظ كأتمتة؛ استخدم حملة يدوية."});
    if(input.eventType==="invoice_issued") throw new TRPCError({code:"BAD_REQUEST",message:"إصدار الفاتورة يُدار عبر مسار رسائل الفاتورة الموحد وإعداد دورة الإرسال؛ لا تُنشئ له أتمتة منفصلة."});
    const {data,error}=await supabaseAdmin().rpc("powerhub_unified_messaging_upsert_automation_v2",{
      p_id:input.id??null,p_tenant_id:access.tenantId,p_site_id:input.siteId,p_template_id:input.templateId,p_name:input.name,p_event_type:input.eventType,
      p_send_type:input.sendType,p_schedule_type:input.scheduleType,p_schedule_anchor_at:input.scheduleAnchorAt?.toISOString()??null,p_timezone:input.timezone,
      p_audience:input.audience,p_trigger_config:input.triggerConfig,p_enabled:input.enabled,p_actor_user_id:ctx.user.id,
    });
    if(error) throw new TRPCError({code:"BAD_REQUEST",message:"تعذر حفظ أتمتة المراسلة."});
    const id=Number(Array.isArray(data)?data[0]?.powerhub_unified_messaging_upsert_automation_v2??data[0]?.id:data);
    if(!id) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد قاعدة البيانات معرف الأتمتة."});
    await writeSupabaseAudit({userId:ctx.user.id,tenantId:access.tenantId,siteId:input.siteId,entityType:"message_automation",entityId:String(id),action:input.id?"update":"create",afterData:{id,name:input.name,eventType:input.eventType,sendType:input.sendType,scheduleType:input.scheduleType,enabled:input.enabled}});
    return {id};
  }),

  setAutomationState: protectedProcedure.input(z.object({siteId:z.number().int().positive(),automationId:z.number().int().positive(),enabled:z.boolean(),archived:z.boolean().default(false)})).mutation(async({ctx,input})=>{
    const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner"],"manageMessaging");
    const {data,error}=await supabaseAdmin().rpc("powerhub_unified_messaging_set_automation_state",{p_tenant_id:access.tenantId,p_site_id:input.siteId,p_automation_id:input.automationId,p_enabled:input.enabled,p_archived:input.archived,p_actor_user_id:ctx.user.id});
    if(error||!data?.[0]) throw new TRPCError({code:"BAD_REQUEST",message:"تعذر تغيير حالة الأتمتة."});
    await writeSupabaseAudit({userId:ctx.user.id,tenantId:access.tenantId,siteId:input.siteId,entityType:"message_automation",entityId:String(input.automationId),action:input.archived?"archive":input.enabled?"enable":"disable",afterData:{enabled:input.enabled,archived:Boolean(data[0].archived_at)}});
    return {id:Number(data[0].id),enabled:Boolean(data[0].enabled),archived:Boolean(data[0].archived_at)};
  }),

  sendManual: protectedProcedure.input(z.object({
    siteId:z.number().int().positive(),templateId:z.number().int().positive(),subscriberIds:z.array(z.number().int().positive()).min(1).max(500),operationId:z.string().uuid(),
  })).mutation(async({ctx,input})=>{
    const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner","manager","accountant"],"manageMessaging");
    const {data,error}=await supabaseAdmin().rpc("powerhub_prepare_manual_message_campaign",{
      p_tenant_id:access.tenantId,p_site_id:input.siteId,p_template_id:input.templateId,p_operation_id:input.operationId,p_subscriber_ids:input.subscriberIds,p_actor_user_id:ctx.user.id,
    });
    if(error) throw new TRPCError({code:"BAD_REQUEST",message:"تعذر تجهيز الحملة اليدوية للمراسلات."});
    const row=Array.isArray(data)?data[0]:data;
    const campaignId=Number(row?.campaign_id);
    if(!campaignId) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد قاعدة البيانات معرف الحملة."});
    const ids=await supabaseAdmin().from("powerhub_message_campaign_recipients").select("notification_id").eq("campaign_id",campaignId);
    const notificationIds=(ids.data??[]).map((r:any)=>Number(r.notification_id)).filter(Number.isInteger);
    const result=notificationIds.length?await processNotificationIdsInBatches(access.tenantId,ctx.user.id,notificationIds):{submitted:0,failed:0,skipped:0,results:[]};
    await supabaseAdmin().from("powerhub_message_campaigns").update({status:result.failed?"partial":"completed",submitted:result.submitted,failed:result.failed,skipped:result.skipped,completed_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",campaignId).eq("tenant_id",access.tenantId);
    await writeSupabaseAudit({userId:ctx.user.id,tenantId:access.tenantId,siteId:input.siteId,entityType:"message_campaign",entityId:String(campaignId),action:"send_manual",metadata:{operationId:input.operationId,requested:input.subscriberIds.length,submitted:result.submitted,failed:result.failed,skipped:result.skipped}});
    return {campaignId,operationId:input.operationId,requested:input.subscriberIds.length,submitted:result.submitted,failed:result.failed,skipped:result.skipped,results:result.results,replayed:Boolean(row?.replayed)};
  }),

  campaign: protectedProcedure.input(z.object({siteId:z.number().int().positive(),operationId:z.string().uuid()})).query(async({ctx,input})=>{
    const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner","manager","accountant","viewer"],"manageMessaging");
    const {data,error}=await supabaseAdmin().rpc("powerhub_unified_messaging_campaign",{p_tenant_id:access.tenantId,p_site_id:input.siteId,p_operation_id:input.operationId});
    if(error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل نتيجة حملة المراسلات."});
    return data?.[0]??null;
  }),

  retryFailed: protectedProcedure.input(z.object({siteId:z.number().int().positive(),campaignId:z.number().int().positive()})).mutation(async({ctx,input})=>{
    const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner","manager","accountant"],"manageMessaging");
    const campaign=await supabaseAdmin().from("powerhub_message_campaigns")
      .select("id,site_id").eq("id",input.campaignId).eq("tenant_id",access.tenantId).eq("site_id",input.siteId).maybeSingle();
    if(campaign.error || !campaign.data) throw new TRPCError({code:"NOT_FOUND",message:"الحملة غير موجودة ضمن الفرع المحدد."});
    const rows=await supabaseAdmin().from("powerhub_message_campaign_recipients").select("notification_id").eq("campaign_id",input.campaignId);
    const ids=(rows.data??[]).map((r:any)=>Number(r.notification_id)).filter(Number.isInteger);
    const failed=await supabaseAdmin().from("notification_messages").select("id").eq("tenant_id",access.tenantId).in("id",ids).eq("status","failed");
    const result=failed.data?.length?await processNotificationIdsInBatches(access.tenantId,ctx.user.id,failed.data.map((r:any)=>Number(r.id))):{submitted:0,failed:0,skipped:0,results:[]};
    return {requested:failed.data?.length??0,submitted:result.submitted,failed:result.failed,skipped:result.skipped,results:result.results};
  }),
});