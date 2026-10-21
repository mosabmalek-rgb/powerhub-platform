import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { supabaseAdmin } from "./supabase-admin";
import { requireSupabaseSiteRole, writeSupabaseAudit } from "./powerhub-supabase";
import { countUnconfirmedNeedsReviewPersistence, countUnpersistedNeedsReview, effectiveNeedsReviewCount, processNotificationById, processNotificationQueueForTenant } from "./notification-worker";
import { renderAutomationTemplate } from "./unified-messaging-template";
import { decimalAmountToMinorUnits, formatPolicyAwareMessageAmount, minorUnitsToAmountString } from "./decimal-money";
import { buildAutomaticOccurrenceKey, buildInvoiceOverdueOperationKey, isIncrementalAutomaticEvent, isInvoiceOverdueEligible, isLaterOverdueInvoiceCandidate } from "./unified-messaging-automation-policy";
import { normalizeInternationalPhone } from "../shared/phone";
import { logSafeSupabaseWorkerQueryFailure } from "./safe-supabase-worker-error";

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

async function loadSubscriberTotalBalances(
  admin: ReturnType<typeof supabaseAdmin>,
  tenantId: number,
  siteId: number,
  subscriberIds: number[],
) {
  const totals = new Map<number, bigint>();
  const uniqueIds = Array.from(new Set(subscriberIds.filter((id) => Number.isSafeInteger(id) && id > 0)));
  for (let offset = 0; offset < uniqueIds.length; offset += 100) {
    const ids = uniqueIds.slice(offset, offset + 100);
    let lastInvoiceId = 0;
    for (;;) {
      const { data, error } = await admin.from("invoices")
        .select("id,subscriber_id,balance_due")
        .eq("tenant_id", tenantId).eq("site_id", siteId)
        .in("subscriber_id", ids).in("status", ["issued", "partially_paid", "overdue"])
        .gt("balance_due", 0).gt("id", lastInvoiceId).order("id", { ascending: true }).limit(500);
      if (error) throw new Error("تعذر حساب إجمالي مستحقات المشترك.");
      for (const invoice of data ?? []) {
        const id = Number(invoice.subscriber_id);
        let balanceMinorUnits: bigint;
        try {
          balanceMinorUnits = decimalAmountToMinorUnits(invoice.balance_due);
        } catch {
          throw new Error("تعذر حساب إجمالي مستحقات المشترك بسبب قيمة مالية غير صالحة.");
        }
        totals.set(id, (totals.get(id) ?? 0n) + balanceMinorUnits);
      }
      if (!data || data.length < 500) break;
      lastInvoiceId = Number(data[data.length - 1].id);
    }
  }
  const formattedTotals = new Map<number, string>();
  for (const [subscriberId, totalMinorUnits] of totals) {
    formattedTotals.set(subscriberId, minorUnitsToAmountString(totalMinorUnits));
  }
  return formattedTotals;
}

async function renderAutomationMessage(
  body: string,
  values: Record<string, string | null | undefined>,
  context: { tenantId: number; siteId: number; actorUserId: number; invoiceId: number | null },
) {
  const admin = supabaseAdmin();
  return renderAutomationTemplate(body, values, async ({ invoiceLink: needsInvoiceLink, portalLink: needsPortalLink }) => {
    let baseUrl = "";
    if ((needsInvoiceLink && context.invoiceId !== null) || needsPortalLink) {
      const base = await admin.rpc("powerhub_public_base_url");
      if (base.error || !base.data) throw new Error("PUBLIC_BASE_URL_NOT_CONFIGURED");
      baseUrl = String(base.data);
    }

    let invoiceLink = "";
    if (needsInvoiceLink && context.invoiceId !== null) {
      const token = crypto.randomBytes(24).toString("base64url");
      const link = await admin.rpc("powerhub_create_invoice_share_link", {
        p_tenant_id: context.tenantId, p_site_id: context.siteId, p_user_id: context.actorUserId,
        p_invoice_id: context.invoiceId,
        p_token_hash: crypto.createHash("sha256").update(token).digest("hex"),
        p_token_preview: token.slice(0, 8), p_expires_at: null,
      });
      if (link.error) throw new Error("تعذر إنشاء رابط الفاتورة.");
      invoiceLink = baseUrl + "/invoice/" + token;
    }

    let portalLink = "";
    if (needsPortalLink) {
      const portal = await admin.from("site_portal_settings").select("portal_code")
        .eq("tenant_id", context.tenantId).eq("site_id", context.siteId).maybeSingle();
      if (portal.error) throw new Error("تعذر تحميل إعدادات بوابة المشترك.");
      portalLink = portal.data?.portal_code ? baseUrl + "/portal?g=" + portal.data.portal_code : "";
    }

    return { invoiceLink, portalLink };
  });
}

async function getCampaignDeliveryCounts(tenantId: number, siteId: number, campaignId: number) {
  const admin = supabaseAdmin();
  const campaign = await admin.from("powerhub_message_campaigns").select("requested,queued,status")
    .eq("id", campaignId).eq("tenant_id", tenantId).eq("site_id", siteId).maybeSingle();
  if (campaign.error || !campaign.data) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل حالة مستلمي الحملة." });
  const recipients = await admin.from("powerhub_message_campaign_recipients").select("notification_id")
    .eq("campaign_id", campaignId);
  if (recipients.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل رسائل الحملة." });
  const ids = Array.from(new Set((recipients.data ?? []).map((r:any) => Number(r.notification_id)).filter((id:number) => Number.isSafeInteger(id) && id > 0)));
  const notifications = ids.length
    ? await admin.from("notification_messages").select("id,status").eq("tenant_id",tenantId).eq("channel","sms").in("id",ids)
    : {data:[],error:null};
  if (notifications.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من حالة رسائل الحملة." });
  const rows = notifications.data ?? [];
  const count = (statuses:string[]) => rows.filter((r:any) => statuses.includes(String(r.status))).length;
  return {
    requested: Number(campaign.data.requested ?? ids.length),
    queued: Number(campaign.data.queued ?? ids.length),
    submitted: count(["submitted","delivered","read"]),
    failed: count(["failed"]),
    skipped: Math.max(0, Number(campaign.data.requested ?? ids.length) - ids.length),
    pending: count(["pending","queued"]),
    processing: count(["processing"]),
    needsReview: count(["needs_review"]),
    status: String(campaign.data.status ?? "processing"),
  };
}

async function processNotificationIdsInBatches(
  tenantId: number,
  actorUserId: number,
  notificationIds: number[],
  heartbeat?: () => Promise<void>,
) {
  const all: Array<{ notificationId: number; status: "submitted" | "failed" | "skipped" | "needs_review"; providerMessageId?: string | null; error?: string; reviewPersistenceState?: "persisted" | "not_persisted" | "unknown" }> = [];
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
    needsReview: all.filter((row) => row.status === "needs_review").length,
    reviewPersistenceFailed: countUnconfirmedNeedsReviewPersistence(all),
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
  const eventType = String(automation.event_type);
  // Invoice-issued messages are enqueued per invoice by the database issuance hook;
  // do not scan subscribers from the periodic automation runner.
  if (eventType === "invoice_issued") return { status: "skipped", requested: 0, queued: 0, failed: 0, skipped: 0 };
  const incrementalAutomaticEvent = automation.send_type === "automatic" && isIncrementalAutomaticEvent(eventType);
  let eventScanSince = String(automation.created_at);
  if (incrementalAutomaticEvent) {
    const previousRun = await admin.from("powerhub_message_automation_runs")
      .select("started_at")
      .eq("tenant_id", Number(automation.tenant_id))
      .eq("site_id", Number(automation.site_id))
      .eq("automation_id", Number(automation.id))
      .eq("status", "completed")
      .not("finished_at", "is", null)
      .like("occurrence_key", `event:${eventType}:%`)
      .order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (previousRun.error) throw new Error("تعذر تحديد نقطة استئناف أتمتة الحدث.");
    if (previousRun.data?.started_at) eventScanSince = String(previousRun.data.started_at);
  }

  let occ: { due: boolean; occurrence_at: string; occurrence_key: string };
  if (automation.send_type === "automatic") {
    occ = {
      due: true,
      occurrence_at: now.toISOString(),
      occurrence_key: buildAutomaticOccurrenceKey(eventType, now),
    };
  } else {
    const occurrence = await admin.rpc("powerhub_unified_messaging_next_occurrence", {
      p_schedule_type: automation.schedule_type,
      p_schedule_anchor_at: automation.schedule_anchor_at,
      p_timezone: automation.timezone,
      p_now: now.toISOString(),
    });
    if (occurrence.error) throw new Error("تعذر حساب موعد أتمتة المراسلة.");
    if (!occurrence.data?.[0]) throw new Error("لم تُعد قاعدة البيانات موعد أتمتة المراسلة.");
    if (!occurrence.data[0].due) return { status: "skipped", requested: 0, queued: 0, failed: 0, skipped: 0 };
    occ = occurrence.data[0];
  }
  const claim = await admin.rpc("powerhub_claim_unified_automation_run", {
    p_tenant_id: Number(automation.tenant_id), p_site_id: Number(automation.site_id),
    p_automation_id: Number(automation.id), p_occurrence_key: String(occ.occurrence_key),
  });
  if (claim.error) throw new Error("تعذر حجز دورة الأتمتة.");
  if (claim.data !== true && !(Array.isArray(claim.data) && claim.data[0] === true)) return { status: "skipped", requested: 0, queued: 0, failed: 0, skipped: 0 };

  async function finishRun(status: "completed" | "skipped" | "failed", requested: number, queued: number, skippedCount: number, failed: number, error: string | null) {
    const result = await admin.rpc("powerhub_finish_unified_automation_run", {
      p_tenant_id: Number(automation.tenant_id),
      p_automation_id: Number(automation.id),
      p_occurrence_key: String(occ.occurrence_key),
      p_status: status,
      p_requested: requested,
      p_queued: queued,
      p_skipped: skippedCount,
      p_failed: failed,
      p_error: error,
    });
    if (result.error) throw new Error("تعذر تثبيت نتيجة دورة الأتمتة.");
  }

  let skipped = 0;
  let requestedCount = 0;
  let queuedCount = 0;
  const tenantId = Number(automation.tenant_id);
  const siteId = Number(automation.site_id);
  let settlementDisplayEnabled = false;
  const audience = automation.audience ?? {};
  const trigger = automation.trigger_config ?? {};

  try {
  const { data: billingPolicy, error: billingPolicyError } = await admin.from("site_billing_policies")
    .select("automatic_fraction_discount_enabled,fraction_carry_enabled")
    .eq("tenant_id", tenantId).eq("site_id", siteId).maybeSingle();
  if (billingPolicyError) throw new Error("تعذر تحميل سياسة تسوية الكسور لتنسيق مبالغ الرسائل.");
  settlementDisplayEnabled = Boolean(
    billingPolicy?.automatic_fraction_discount_enabled || billingPolicy?.fraction_carry_enabled,
  );

  const template = automation.template;
  if (!template?.is_active || template.channel !== "sms") {
    await finishRun("skipped", 0, 0, 0, 0, "TEMPLATE_DISABLED");
    return { status: "skipped", requested: 0, queued: 0, failed: 0, skipped: 0 };
  }

  async function getPersistedOperationMap(operationKeys: string[]) {
    const keys = Array.from(new Set(operationKeys.filter(Boolean)));
    if (!keys.length) return new Map<string, any>();
    const { data, error } = await admin.from("notification_messages")
      .select("id,operation_key,payload")
      .eq("tenant_id", tenantId)
      .in("operation_key", keys);
    if (error) throw new Error("تعذر التحقق من مفاتيح عمليات الأتمتة السابقة.");
    return new Map((data ?? []).map((row: any) => [String(row.operation_key), row]));
  }

  function accountForExistingOperation(operationKey: string, persisted: any): boolean {
    if (!persisted) return false;
    if (String(persisted.payload?.occurrenceKey ?? "") === String(occ.occurrence_key)) queuedCount++;
    else skipped++;
    return true;
  }

  async function queueRows(rows: any[]) {
    if (!rows.length) return;
    const result = await admin.from("notification_messages").upsert(rows, {
      onConflict: "tenant_id,operation_key",
      ignoreDuplicates: true,
    }).select("id");
    if (result.error) throw new Error("تعذر إدخال رسائل الأتمتة إلى الطابور.");
    const operationKeys = rows.map((row) => String(row.operation_key)).filter(Boolean);
    if (!operationKeys.length) return;
    const { data: persistedRows, error: persistedError } = await admin
      .from("notification_messages")
      .select("id,operation_key,payload")
      .eq("tenant_id", tenantId)
      .in("operation_key", operationKeys);
    if (persistedError) throw new Error("تعذر التحقق من رسائل الأتمتة المثبتة في الطابور.");
    const persistedByKey = new Map((persistedRows ?? []).map((row: any) => [String(row.operation_key), row]));
    const currentOccurrenceRows = (persistedRows ?? []).filter((row: any) =>
      String(row.payload?.occurrenceKey ?? "") === String(occ.occurrence_key)
    );
    queuedCount += new Set(currentOccurrenceRows.map((row: any) => Number(row.id)).filter(Number.isInteger)).size;
    skipped += operationKeys.filter((key) => {
      const persisted = persistedByKey.get(key);
      return Boolean(persisted) && String((persisted as any).payload?.occurrenceKey ?? "") !== String(occ.occurrence_key);
    }).length;
  }

  async function heartbeat() {
    const touched = await admin.rpc("powerhub_touch_unified_automation_run", {
      p_tenant_id: tenantId,
      p_automation_id: Number(automation.id),
      p_occurrence_key: occ.occurrence_key,
    });
    if (touched.error || touched.data !== true) {
      throw new Error("تعذر تجديد قفل تنفيذ أتمتة المراسلة.");
    }
  }

  const buildBaseQuery = () => admin.from("subscribers")
    .select("id,full_name,subscriber_no,phone,service_status,created_at")
    .eq("tenant_id", tenantId).eq("site_id", siteId).is("archived_at", null);

  if (eventType === "payment_received") {
    let lastPaymentId = 0;
    for (;;) {
      const { data: payments, error: paymentsError } = await admin.from("payments")
        .select("id,subscriber_id,invoice_id,amount,paid_at")
        .eq("tenant_id", tenantId).eq("site_id", siteId).eq("status", "completed")
        .gte("created_at", incrementalAutomaticEvent ? eventScanSince : new Date(automation.created_at).toISOString())
        .gt("id", lastPaymentId).order("id", { ascending: true }).limit(500);
      if (paymentsError) throw new Error("تعذر تحميل دفعات الأتمتة.");
      if (!payments?.length) break;
      requestedCount += payments.length;
      lastPaymentId = Number(payments[payments.length - 1].id);

      const paymentOperationKeys = payments.map((payment: any) => `automation:${automation.id}:payment:${payment.id}`);
      const persistedPayments = await getPersistedOperationMap(paymentOperationKeys);
      const freshPayments = payments.filter((payment: any) => {
        const key = `automation:${automation.id}:payment:${payment.id}`;
        return !accountForExistingOperation(key, persistedPayments.get(key));
      });
      if (!freshPayments.length) {
        if (payments.length === 500) { await heartbeat(); continue; }
        break;
      }

      const subscriberIds = Array.from(new Set(freshPayments.map((p: any) => Number(p.subscriber_id))));
      const { data: subscribers, error: subscribersError } = await admin.from("subscribers")
        .select("id,full_name,subscriber_no,phone")
        .eq("tenant_id", tenantId).eq("site_id", siteId).in("id", subscriberIds);
      if (subscribersError) throw new Error("تعذر تحميل مشتركي الأتمتة.");
      const subscriberMap = new Map((subscribers ?? []).map((s: any) => [Number(s.id), s]));

      const invoiceIds = freshPayments.map((p: any) => p.invoice_id).filter(Boolean).map(Number);
      const { data: invoices, error: invoicesError } = invoiceIds.length
        ? await admin.from("invoices").select("id,subscriber_id,invoice_no,billing_period,total_amount,balance_due,due_date,previous_reading,current_reading,consumption_kwh").eq("tenant_id",tenantId).eq("site_id",siteId).in("id",invoiceIds)
        : { data: [], error: null };
      if (invoicesError) throw new Error("تعذر تحميل فواتير الأتمتة.");
      const invoiceMap = new Map((invoices ?? []).map((i: any) => [Number(i.id), i]));
      const totalBalanceBySubscriber = await loadSubscriberTotalBalances(admin, tenantId, siteId, subscriberIds);

      const rows = [];
      for (const payment of freshPayments) {
        const subscriber = subscriberMap.get(Number(payment.subscriber_id));
        if (!subscriber) { skipped++; continue; }
        const invoice = payment.invoice_id ? invoiceMap.get(Number(payment.invoice_id)) : null;
        if (invoice && Number(invoice.subscriber_id) !== Number(payment.subscriber_id)) { skipped++; continue; }
        const values = {
          subscriber_name: subscriber.full_name ?? "", subscriber_no: subscriber.subscriber_no ?? "",
          invoice_no: invoice?.invoice_no ?? "", billing_period: invoice?.billing_period ?? "",
          total_amount: invoice?.total_amount == null ? "" : formatPolicyAwareMessageAmount(String(invoice.total_amount), settlementDisplayEnabled),
          balance_due: invoice?.balance_due == null ? "" : formatPolicyAwareMessageAmount(String(invoice.balance_due), settlementDisplayEnabled),
          previous_reading: invoice?.previous_reading == null ? "" : String(invoice.previous_reading),
          current_reading: invoice?.current_reading == null ? "" : String(invoice.current_reading),
          consumption_kwh: invoice?.consumption_kwh == null ? "" : String(invoice.consumption_kwh),
          total_balance: formatPolicyAwareMessageAmount(totalBalanceBySubscriber.get(Number(subscriber.id)) ?? "0", settlementDisplayEnabled),
          due_date: invoice?.due_date ? new Date(invoice.due_date).toLocaleDateString("ar-PS") : "",
        };
        const renderedText = await renderAutomationMessage(template.body, values, {
          tenantId, siteId, actorUserId, invoiceId: invoice?.id == null ? null : Number(invoice.id),
        });
        rows.push({
          tenant_id: tenantId, subscriber_id: Number(subscriber.id), invoice_id: invoice?.id ?? null,
          channel: "sms", event_type: "payment_received", recipient: subscriber.phone ?? "", status: "pending", scheduled_at: occ.occurrence_at,
          send_type: automation.send_type, schedule_type: automation.schedule_type, template_id: Number(template.id),
          automation_id: Number(automation.id), operation_key: `automation:${automation.id}:payment:${payment.id}`,
          payload: { renderedText, operationKey: `automation:${automation.id}:payment:${payment.id}`, automationId: Number(automation.id), occurrenceKey: occ.occurrence_key },
        });
      }
      await queueRows(rows);
      if (payments.length === 500) await heartbeat();
      else break;
    }
  } else {
    let lastSubscriberId = 0;
    for (;;) {
      let query = buildBaseQuery().gt("id", lastSubscriberId).order("id", { ascending: true }).limit(500);
      if (incrementalAutomaticEvent && eventType === "subscriber_created") query = query.gte("created_at", eventScanSince);
      if (Array.isArray(audience.subscriberIds) && audience.subscriberIds.length) query = query.in("id", audience.subscriberIds.map(Number));
      if (audience.serviceStatus) query = query.eq("service_status", audience.serviceStatus);
      const { data: rawSubscribers, error: subscribersError } = await query;
      if (subscribersError) throw new Error("تعذر تحميل مشتركي الأتمتة.");
      if (!rawSubscribers?.length) break;
      lastSubscriberId = Number(rawSubscribers[rawSubscribers.length - 1].id);
      let subscribers = rawSubscribers;
      if (eventType === "subscriber_created") {
        const createdSince = incrementalAutomaticEvent ? eventScanSince : String(automation.created_at);
        subscribers = subscribers.filter((s: any) => new Date(s.created_at) >= new Date(createdSince));
      }
      requestedCount += subscribers.length;

      if (eventType === "invoice_issued") {
        skipped += subscribers.length;
      } else {
        const rows = [];
        let invoiceMap = new Map<number, any>();
        const afterDueHours = Number(trigger.afterDueHours ?? (trigger.afterDueDays == null ? 24 : Number(trigger.afterDueDays) * 24));
        const minBalance = trigger.minBalance == null ? null : Number(trigger.minBalance);
        if (eventType === "invoice_overdue") {
          const ids = subscribers.map((s: any) => Number(s.id));
          let lastInvoiceId = 0;
          for (;;) {
            const { data: invoices, error: invoicesError } = await admin.from("invoices")
              .select("id,subscriber_id,invoice_no,billing_period,total_amount,balance_due,due_date,status,previous_reading,current_reading,consumption_kwh")
              .eq("tenant_id", tenantId).eq("site_id", siteId).in("subscriber_id", ids)
              .in("status", ["issued","partially_paid","overdue"]).gt("balance_due", 0).lte("due_date", now.toISOString())
              .gt("id", lastInvoiceId).order("id", { ascending: true }).limit(500);
            if (invoicesError) throw new Error("تعذر تحميل فواتير الأتمتة.");
            if (!invoices?.length) break;
            for (const invoice of invoices) {
              if (!isInvoiceOverdueEligible({ dueDate: invoice.due_date, balanceDue: invoice.balance_due, now, afterDueHours, minBalance })) continue;
              const key = Number(invoice.subscriber_id);
              const previous = invoiceMap.get(key);
              if (!previous || isLaterOverdueInvoiceCandidate({ dueDate: invoice.due_date, invoiceId: invoice.id }, { dueDate: previous.due_date, invoiceId: previous.id })) {
                invoiceMap.set(key, invoice);
              }
            }
            lastInvoiceId = Number(invoices[invoices.length - 1].id);
            if (invoices.length < 500) break;
            await heartbeat();
          }
        }

        const totalBalanceBySubscriber = await loadSubscriberTotalBalances(admin, tenantId, siteId, subscribers.map((subscriber: any) => Number(subscriber.id)));
        const candidates: Array<{ subscriber: any; invoice: any | null; operationKey: string; values: Record<string, string> }> = [];
        for (const subscriber of subscribers) {
          const invoice = eventType === "invoice_overdue" ? invoiceMap.get(Number(subscriber.id)) : null;
          if (eventType === "invoice_overdue") {
            if (!invoice || !isInvoiceOverdueEligible({ dueDate: invoice.due_date, balanceDue: invoice.balance_due, now, afterDueHours, minBalance })) { skipped++; continue; }
          }

          const operationKey = eventType === "invoice_overdue"
            ? buildInvoiceOverdueOperationKey(automation.id, invoice.id, occ.occurrence_key, automation.send_type === "automatic" && automation.schedule_type === "none")
            : eventType === "service_alert"
              ? `automation:${automation.id}:subscriber:${subscriber.id}:occurrence:${occ.occurrence_key}`
              : `automation:${automation.id}:subscriber:${subscriber.id}`;
          const values = {
            subscriber_name: subscriber.full_name ?? "", subscriber_no: subscriber.subscriber_no ?? "",
            invoice_no: invoice?.invoice_no ?? "", billing_period: invoice?.billing_period ?? "",
            total_amount: invoice?.total_amount == null ? "" : formatPolicyAwareMessageAmount(String(invoice.total_amount), settlementDisplayEnabled),
            balance_due: invoice?.balance_due == null ? "" : formatPolicyAwareMessageAmount(String(invoice.balance_due), settlementDisplayEnabled),
            previous_reading: invoice?.previous_reading == null ? "" : String(invoice.previous_reading),
            current_reading: invoice?.current_reading == null ? "" : String(invoice.current_reading),
            consumption_kwh: invoice?.consumption_kwh == null ? "" : String(invoice.consumption_kwh),
            total_balance: formatPolicyAwareMessageAmount(totalBalanceBySubscriber.get(Number(subscriber.id)) ?? "0", settlementDisplayEnabled),
            due_date: invoice?.due_date ? new Date(invoice.due_date).toLocaleDateString("ar-PS") : "",
          };
          candidates.push({ subscriber, invoice, operationKey, values });
        }

        const persistedCandidates = await getPersistedOperationMap(candidates.map((candidate) => candidate.operationKey));
        for (const candidate of candidates) {
          if (accountForExistingOperation(candidate.operationKey, persistedCandidates.get(candidate.operationKey))) continue;
          const { subscriber, invoice, operationKey, values } = candidate;
          const textBody = await renderAutomationMessage(template.body, values, {
            tenantId, siteId, actorUserId, invoiceId: invoice?.id == null ? null : Number(invoice.id),
          });
          rows.push({
            tenant_id: tenantId, subscriber_id: Number(subscriber.id), invoice_id: invoice?.id ?? null,
            channel: "sms", event_type: eventType === "subscriber_created" ? "subscriber_reference" : eventType,
            recipient: subscriber.phone ?? "", status: "pending", scheduled_at: occ.occurrence_at, send_type: automation.send_type,
            schedule_type: automation.schedule_type, template_id: Number(template.id), automation_id: Number(automation.id),
            operation_key: operationKey, payload: { renderedText: textBody, operationKey, automationId: Number(automation.id), occurrenceKey: occ.occurrence_key },
          });
        }
        await queueRows(rows);
      }
      if (rawSubscribers.length === 500) await heartbeat();
      else break;
    }
  }
  await finishRun("completed", requestedCount, queuedCount, skipped, 0, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : "فشل تنفيذ أتمتة المراسلة.";
    // Release the active lease with a durable failure outcome instead of
    // leaving the occurrence in processing until the stale-lease timeout.
    await finishRun("failed", requestedCount, queuedCount, skipped, 1, message);
    throw error;
  }
  await writeSupabaseAudit({
    userId: actorUserId, tenantId, siteId, entityType: "message_automation", entityId: String(automation.id),
    action: "execute", metadata: { occurrenceKey: occ.occurrence_key, requested: requestedCount, queued: queuedCount, submitted: 0, failed: 0, skipped },
  });
  return { status: "completed", requested: requestedCount, queued: queuedCount, failed: 0, skipped };
}

export async function processUnifiedMessagingAutomations(now = new Date()) {
  const admin = supabaseAdmin();
  const { error: reclaimError } = await admin.rpc("powerhub_reclaim_stale_sms_notifications", { p_limit: 200 });
  if (reclaimError) {
    logSafeSupabaseWorkerQueryFailure("unified-messaging", "stale-message reclaim", reclaimError);
    throw new Error("تعذر استرداد رسائل المراسلة الموحدة العالقة قبل بدء دورة الأتمتة.");
  }
  const results: Array<Record<string, unknown>> = [];
  let lastAutomationId = 0;
  let actorUserId: number | null = null;
  for (;;) {
    const { data: rows, error } = await admin.from("powerhub_message_automations")
      .select("id,tenant_id,site_id,template_id,name,event_type,send_type,schedule_type,schedule_anchor_at,timezone,audience,trigger_config,created_at")
      .eq("enabled", true).is("archived_at", null)
      .gt("id", lastAutomationId).order("id", { ascending: true }).limit(500);
    if (error) {
      logSafeSupabaseWorkerQueryFailure("unified-messaging", "enabled automation query", error);
      throw new Error("تعذر تحميل أتمتة المراسلة المفعلة.");
    }
    if (!rows?.length) break;
    const scopedRows = rows.filter((row: any) => row.site_id != null);
    if (scopedRows.length && actorUserId === null) actorUserId = await getPlatformActorId();
    for (const row of scopedRows) {
      try {
        const { data: template, error: templateError } = await admin.from("powerhub_message_templates")
          .select("id,body,channel,is_active").eq("id", Number(row.template_id)).maybeSingle();
        if (templateError) throw new Error("تعذر تحميل قالب أتمتة المراسلة.");
        results.push({ automationId: Number(row.id), ...(await executeAutomation({ ...row, template }, now, actorUserId!)) });
      } catch (error) {
        results.push({ automationId: Number(row.id), status: "failed", error: error instanceof Error ? error.message : "فشل تنفيذ الأتمتة." });
      }
    }
    lastAutomationId = Number(rows[rows.length - 1].id);
    if (rows.length < 500) break;
  }
  return { automations: results.length, results };
}


type UnifiedMessageHistoryInput = {
  siteId: number;
  period: "cycle" | "today" | "custom";
  startDate?: string;
  endDate?: string;
  type: "all" | "invoice_issued" | "payment_reminder" | "payment_received" | "subscriber_reference" | "service_alert" | "manual" | "automatic";
  channel: "all" | "sms" | "whatsapp";
  status: "all" | "pending" | "processing" | "submitted" | "delivered" | "read" | "failed" | "needs_review";
  search?: string;
  limit: number;
  offset: number;
};

const HISTORY_PAGE_SIZE = 500;
const HISTORY_MAX_ROWS = 50_000;
const HISTORY_ID_CHUNK_SIZE = 500;

function historyDateIsValid(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addCalendarDay(value: string): string {
  const parsed = new Date(value + "T00:00:00.000Z");
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function localMidnightUtc(value: string, timeZone: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const targetLocalAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let guess = targetLocalAsUtc;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    ) as Record<string, string>;
    const localAsUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second), 0,
    );
    const correction = targetLocalAsUtc - localAsUtc;
    guess += correction;
    if (correction === 0) break;
  }
  return new Date(guess).toISOString();
}

function addOneMicrosecond(value: string): string {
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) throw new Error("Invalid timestamp returned by reading-cycle authority.");
  const secondPart = match[1];
  const fraction = match[2] ?? "";
  const zone = match[3];
  const microseconds = Number(fraction.padEnd(6, "0").slice(0, 6)) + 1;
  if (microseconds < 1_000_000) {
    return secondPart + "." + String(microseconds).padStart(6, "0") + zone;
  }
  return new Date(Date.parse(secondPart + zone) + 1000).toISOString();
}

async function readAllHistoryRows(
  queryPage: (from: number, to: number) => any,
  failureMessage: string,
): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; from <= HISTORY_MAX_ROWS; from += HISTORY_PAGE_SIZE) {
    const { data, error } = await queryPage(from, from + HISTORY_PAGE_SIZE - 1);
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: failureMessage });
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (rows.length > HISTORY_MAX_ROWS) {
      throw new TRPCError({
        code: "PAYLOAD_TOO_LARGE",
        message: "حجم سجل الرسائل لهذه الفترة كبير جدًا؛ ضيّق الفترة الزمنية ثم أعد المحاولة.",
      });
    }
    if (page.length < HISTORY_PAGE_SIZE) return rows;
  }
  throw new TRPCError({
    code: "PAYLOAD_TOO_LARGE",
    message: "حجم سجل الرسائل لهذه الفترة كبير جدًا؛ ضيّق الفترة الزمنية ثم أعد المحاولة.",
  });
}

async function readHistoryRowsByIds(
  admin: any,
  table: string,
  ids: number[],
  columns: string,
  idColumn = "id",
): Promise<any[]> {
  const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0)));
  const rows: any[] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += HISTORY_ID_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(offset, offset + HISTORY_ID_CHUNK_SIZE);
    const { data, error } = await admin.from(table).select(columns).in(idColumn, chunk);
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل تفاصيل سجل الرسائل." });
    rows.push(...(Array.isArray(data) ? data : []));
  }
  return rows;
}

function historyMapById(rows: any[]): Map<number, any> {
  return new Map(rows.map((row) => [Number(row.id), row]));
}

function historyTemplateText(payload: any): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  for (const key of ["renderedText", "message", "body", "text"]) {
    if (typeof payload[key] === "string" && payload[key].length > 0) return payload[key];
  }
  return "";
}

async function loadUnifiedMessageHistoryFromTables(
  admin: any,
  tenantId: number,
  input: UnifiedMessageHistoryInput,
): Promise<any> {
  const siteId = input.siteId;
  const configuration = await admin.from("tenant_reading_cycle_configurations")
    .select("timezone")
    .eq("tenant_id", tenantId)
    .eq("site_id", siteId)
    .maybeSingle();
  if (configuration.error) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل المنطقة الزمنية للفرع." });
  }
  const timeZone = String(configuration.data?.timezone || "Asia/Gaza");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "المنطقة الزمنية المضبوطة لهذا الفرع غير صالحة." });
  }
  let startAt: string;
  let endAt: string;
  let cycleEndInclusive = false;

  if (input.period === "cycle") {
    const cycleResult = await admin.rpc("powerhub_cycle_for_reading", {
      p_tenant_id: tenantId,
      p_site_id: siteId,
      p_reading_at: new Date().toISOString(),
    });
    if (cycleResult.error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحديد دورة القراءة والفوترة الحالية." });
    }
    const cycle = Array.isArray(cycleResult.data) ? cycleResult.data[0] : cycleResult.data;
    if (!cycle?.cycle_start_at || !cycle?.cycle_end_at) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا توجد دورة قراءة وفوترة محددة لهذا الفرع." });
    }
    startAt = String(cycle.cycle_start_at);
    endAt = String(cycle.cycle_end_at);
    cycleEndInclusive = true;
  } else {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const localStartDate = input.period === "today" ? today : String(input.startDate ?? "");
    const localEndDate = input.period === "today" ? today : String(input.endDate ?? "");
    if (!historyDateIsValid(localStartDate) || !historyDateIsValid(localEndDate) || localStartDate > localEndDate) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "حدد نطاقًا زمنيًا صحيحًا؛ تاريخ النهاية يجب ألا يسبق البداية." });
    }
    startAt = localMidnightUtc(localStartDate, timeZone);
    endAt = localMidnightUtc(addCalendarDay(localEndDate), timeZone);
  }

  const messageColumns = [
    "id", "tenant_id", "site_id", "invoice_id", "subscriber_id", "channel", "event_type", "recipient", "status",
    "provider_message_id", "payload", "attempts", "last_error", "created_at", "updated_at", "scheduled_at",
    "send_type", "schedule_type", "operation_key", "template_id", "automation_id",
  ].join(", ");
  const messageRows = await readAllHistoryRows((from, to) => {
    let query = admin.from("notification_messages").select(messageColumns)
      .eq("tenant_id", tenantId)
      .gte("created_at", startAt);
    query = cycleEndInclusive ? query.lte("created_at", endAt) : query.lt("created_at", endAt);
    if (input.channel !== "all") query = query.eq("channel", input.channel);
    if (input.status !== "all") query = query.eq("status", input.status);
    if (input.type === "subscriber_reference") query = query.in("event_type", ["subscriber_reference", "subscriber_created"]);
    else if (input.type === "payment_reminder") query = query.in("event_type", ["payment_reminder", "invoice_overdue"]);
    else if (!["all", "manual", "automatic"].includes(input.type)) query = query.eq("event_type", input.type);
    return query.order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to);
  }, "تعذر تحميل رسائل الفترة المحددة.");

  if (!messageRows.length) {
    return {
      items: [], total: 0, page: Math.floor(input.offset / input.limit) + 1, limit: input.limit, offset: input.offset,
      campaignCount: 0,
      stats: { total: 0, submitted: 0, failed: 0, pending: 0, processing: 0, needsReview: 0, campaigns: 0 },
      period: input.period, periodStart: startAt,
      periodEndExclusive: cycleEndInclusive ? addOneMicrosecond(endAt) : endAt, timezone: timeZone,
    };
  }

  const ids = (values: any[]) => Array.from(new Set(values.filter((value) => value !== null && value !== undefined).map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0)));
  const notificationIds = ids(messageRows.map((row) => row.id));
  const subscriberIds = ids(messageRows.map((row) => row.subscriber_id));
  const invoiceIds = ids(messageRows.map((row) => row.invoice_id));
  const automationIds = ids(messageRows.map((row) => row.automation_id));
  const messageTemplateIds = ids(messageRows.map((row) => row.template_id));

  const [subscriberRows, invoiceRows, automationRows, recipientRows] = await Promise.all([
    readHistoryRowsByIds(admin, "subscribers", subscriberIds, "id,tenant_id,site_id,full_name,subscriber_no"),
    readHistoryRowsByIds(admin, "invoices", invoiceIds, "id,tenant_id,site_id,invoice_no"),
    readHistoryRowsByIds(admin, "powerhub_message_automations", automationIds, "id,tenant_id,site_id,name,template_id"),
    (async () => {
      const rows: any[] = [];
      for (let offset = 0; offset < notificationIds.length; offset += HISTORY_ID_CHUNK_SIZE) {
        const chunk = notificationIds.slice(offset, offset + HISTORY_ID_CHUNK_SIZE);
        const { data, error } = await admin.from("powerhub_message_campaign_recipients")
          .select("id,campaign_id,notification_id,subscriber_id")
          .in("notification_id", chunk);
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل روابط حملات الرسائل." });
        rows.push(...(data ?? []));
      }
      return rows;
    })(),
  ]);

  const campaignIds = ids(recipientRows.map((row) => row.campaign_id));
  const campaignRows = await readHistoryRowsByIds(admin, "powerhub_message_campaigns", campaignIds, "id,tenant_id,site_id,template_id");
  const templateIds = ids([
    ...messageTemplateIds,
    ...automationRows.map((row) => row.template_id),
    ...campaignRows.map((row) => row.template_id),
  ]);
  const templateRows = await readHistoryRowsByIds(admin, "powerhub_message_templates", templateIds, "id,tenant_id,name");

  const subscribers = historyMapById(subscriberRows);
  const invoices = historyMapById(invoiceRows);
  const automations = historyMapById(automationRows);
  const campaigns = historyMapById(campaignRows);
  const templates = historyMapById(templateRows.filter((row) => Number(row.tenant_id) === tenantId));
  const campaignRecipients = new Map<number, any>();
  for (const row of recipientRows) campaignRecipients.set(Number(row.notification_id), row);

  const search = input.search?.trim().toLocaleLowerCase() || "";
  const scopedRows: any[] = [];
  for (const message of messageRows) {
    const messageId = Number(message.id);
    const subscriber = message.subscriber_id == null ? null : subscribers.get(Number(message.subscriber_id));
    const invoice = message.invoice_id == null ? null : invoices.get(Number(message.invoice_id));
    const automation = message.automation_id == null ? null : automations.get(Number(message.automation_id));
    const recipientLink = campaignRecipients.get(messageId);
    const candidateCampaign = recipientLink ? campaigns.get(Number(recipientLink.campaign_id)) : null;
    const campaign = candidateCampaign && Number(candidateCampaign.tenant_id) === tenantId ? candidateCampaign : null;

    // Campaign recipients are a relationship, not a second message. Reject malformed or crossed links.
    if (recipientLink && (
      !candidateCampaign
      || Number(candidateCampaign.tenant_id) !== tenantId
      || Number(recipientLink.subscriber_id) !== Number(message.subscriber_id)
    )) continue;

    // Fail closed if a referenced entity is missing, belongs to another tenant, or points at another site.
    if (message.site_id != null && Number(message.site_id) !== siteId) continue;
    if (message.subscriber_id != null && (!subscriber || Number(subscriber.tenant_id) !== tenantId)) continue;
    if (message.invoice_id != null && (!invoice || Number(invoice.tenant_id) !== tenantId)) continue;
    if (message.automation_id != null && (!automation || Number(automation.tenant_id) !== tenantId)) continue;
    if (candidateCampaign && Number(candidateCampaign.tenant_id) !== tenantId) continue;
    if (subscriber && Number(subscriber.site_id) !== siteId) continue;
    if (invoice && Number(invoice.site_id) !== siteId) continue;
    if (campaign && Number(campaign.site_id) !== siteId) continue;
    if (automation?.site_id != null && Number(automation.site_id) !== siteId) continue;

    const inSite = Number(message.site_id) === siteId
      || Number(subscriber?.site_id) === siteId
      || Number(invoice?.site_id) === siteId
      || Number(campaign?.site_id) === siteId
      || Number(automation?.site_id) === siteId;
    if (!inSite) continue;

    const campaignTemplate = campaign ? templates.get(Number(campaign.template_id)) : null;
    const messageTemplate = message.template_id == null ? null : templates.get(Number(message.template_id));
    const templateName = campaignTemplate?.name ?? messageTemplate?.name ?? automation?.name ?? null;
    const source = campaign || message.event_type === "manual" || message.send_type === "manual"
      ? "manual"
      : automation || ["automatic", "scheduled"].includes(String(message.send_type))
        ? "automatic"
        : "legacy";

    const row = {
      id: message.id,
      invoiceId: message.invoice_id,
      invoiceNo: invoice?.invoice_no ?? null,
      subscriberId: message.subscriber_id,
      subscriberName: subscriber?.full_name ?? null,
      subscriberNo: subscriber?.subscriber_no ?? null,
      recipient: message.recipient,
      channel: message.channel,
      eventType: message.event_type,
      status: message.status,
      providerMessageId: message.provider_message_id,
      attempts: message.attempts,
      lastError: message.last_error,
      messageText: historyTemplateText(message.payload),
      createdAt: message.created_at,
      updatedAt: message.updated_at,
      scheduledAt: message.scheduled_at,
      sendType: message.send_type,
      scheduleType: message.schedule_type,
      source,
      campaignId: campaign?.id ?? null,
      campaignLabel: campaign ? "حملة #" + campaign.id + (templateName ? " — " + templateName : "") : null,
      automationId: automation?.id ?? null,
      automationName: automation?.name ?? null,
      templateName,
      operationKey: message.operation_key,
    };

    const normalizedSearch = [
      row.subscriberName, row.subscriberNo, row.recipient, row.invoiceNo,
      row.campaignId == null ? "" : String(row.campaignId), row.templateName, row.messageText,
    ].map((value) => String(value ?? "").toLocaleLowerCase()).join("\n");
    if (search && !normalizedSearch.includes(search)) continue;
    if (input.type === "manual" && source !== "manual") continue;
    if (input.type === "automatic" && source !== "automatic") continue;
    if (input.type === "subscriber_reference" && !["subscriber_reference", "subscriber_created"].includes(String(row.eventType))) continue;
    if (input.type === "payment_reminder" && !["payment_reminder", "invoice_overdue"].includes(String(row.eventType))) continue;
    if (!["all", "manual", "automatic", "subscriber_reference", "payment_reminder"].includes(input.type)
      && row.eventType !== input.type) continue;
    scopedRows.push(row);
  }

  scopedRows.sort((left, right) => {
    const timeDifference = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    return timeDifference || Number(right.id) - Number(left.id);
  });
  const campaignsInResult = new Set(scopedRows.map((row) => row.campaignId).filter((id) => id != null).map(String));
  const stats = {
    total: scopedRows.length,
    submitted: scopedRows.filter((row) => ["submitted", "delivered", "read"].includes(String(row.status))).length,
    failed: scopedRows.filter((row) => row.status === "failed").length,
    pending: scopedRows.filter((row) => row.status === "pending").length,
    processing: scopedRows.filter((row) => row.status === "processing").length,
    needsReview: scopedRows.filter((row) => row.status === "needs_review").length,
    campaigns: campaignsInResult.size,
  };
  return {
    items: scopedRows.slice(input.offset, input.offset + input.limit),
    total: scopedRows.length,
    page: Math.floor(input.offset / input.limit) + 1,
    limit: input.limit,
    offset: input.offset,
    campaignCount: campaignsInResult.size,
    stats,
    period: input.period,
    periodStart: startAt,
    periodEndExclusive: cycleEndInclusive ? addOneMicrosecond(endAt) : endAt,
    timezone: timeZone,
  };
}

export const powerhubUnifiedMessagingRouter = router({
  connectionReadiness: protectedProcedure.input(z.object({ siteId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner","manager","accountant","viewer"], "manageMessaging");
    const { data, error } = await supabaseAdmin().from("tenant_tweetsms_accounts")
      .select("api_endpoint,sender_name,credential_ciphertext,credential_iv,is_active,last_tested_at,last_error")
      .eq("tenant_id", access.tenantId).maybeSingle();
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من جاهزية ربط TweetSMS." });
    if (!data) return { status: "not_configured" as const, ready: false, label: "الربط غير مُعدّ", detail: "لم تُحفظ بيانات ربط TweetSMS لهذا المولد." };
    const configured = Boolean(data.api_endpoint?.trim() && data.sender_name?.trim() && data.credential_ciphertext?.trim() && data.credential_iv?.trim());
    if (!configured) return { status: "incomplete" as const, ready: false, label: "بيانات الربط غير مكتملة", detail: "أكمل عنوان API والمفتاح واسم المرسل من حسابات TweetSMS لدى مدير المنصة." };
    if (!data.is_active) return { status: "inactive" as const, ready: false, label: "الربط غير مفعّل", detail: "تم حفظ البيانات، لكن الإرسال غير مفعّل. يلزم نجاح فحص الاتصال ثم تفعيل الحساب." };
    if (!data.last_tested_at) return { status: "untested" as const, ready: false, label: "الربط لم يُختبر", detail: "الحساب مفعّل لكن لا يوجد فحص اتصال ناجح مسجّل؛ لا تعتبره جاهزًا للإرسال." };
    if (data.last_error) return { status: "error" as const, ready: false, label: "يوجد خطأ في الربط", detail: String(data.last_error).slice(0, 240) };
    return { status: "ready" as const, ready: true, label: "الربط فعال وجاهز", detail: "بيانات الربط مكتملة والحساب مفعّل وآخر فحص اتصال ناجح." };
  }),
  templates: protectedProcedure.input(z.object({
    siteId: z.number().int().positive(), channel: channelSchema.optional(), eventType: eventTypeSchema.optional(),
  })).query(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner","manager","accountant","viewer"], "manageMessaging");
    const { data, error } = await supabaseAdmin().rpc("powerhub_unified_messaging_templates", {
      p_tenant_id: access.tenantId, p_channel: input.channel ?? null, p_event_type: input.eventType ?? null,
    });
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل قوالب المراسلة الموحدة." });
    let invoiceStyle: "details" | "portal_link" = "details";
    const invoiceConfig = await supabaseAdmin().from("tenant_messaging_configurations")
      .select("invoice_message_style").eq("tenant_id", access.tenantId).eq("channel", "sms").maybeSingle();
    if (invoiceConfig.error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تحميل إعداد طريقة رسالة الفاتورة." });
    invoiceStyle = invoiceConfig.data?.invoice_message_style === "portal_link" ? "portal_link" : "details";
    return (data ?? []).map((row: any) => ({
      ...asTemplate(row),
      invoiceStyle: row.event_type === "invoice_issued" && row.channel === "sms" ? invoiceStyle : null,
    }));
  }),

  saveTemplate: protectedProcedure.input(z.object({
    siteId: z.number().int().positive(), id: z.number().int().positive().optional(),
    name: z.string().trim().min(2).max(120), description: z.string().trim().max(500).optional(),
    channel: channelSchema, eventType: eventTypeSchema.optional(), body: z.string().trim().min(1).max(4096),
    variables: z.array(z.string().trim().min(1).max(80)).max(50).default([]), isActive: z.boolean().default(true),
    invoiceStyle: z.enum(["details","portal_link"]).optional(),
  })).mutation(async ({ ctx, input }) => {
    const access = await requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner"], "manageMessaging");
    const admin = supabaseAdmin();
    const wantsInvoiceStyle = input.channel === "sms" && input.eventType === "invoice_issued" && input.invoiceStyle !== undefined;
    let invoiceStyleToPersist = wantsInvoiceStyle ? input.invoiceStyle! : null;

    // Saving a reusable template must not depend on the SMS provider having been configured.
    // The invoice-style preference belongs to the tenant's SMS configuration, so persist it
    // only when that row exists; never create a fake provider configuration just to save a template.
    if (wantsInvoiceStyle) {
      const { data: smsConfiguration, error: configurationError } = await admin
        .from("tenant_messaging_configurations")
        .select("id")
        .eq("tenant_id", access.tenantId)
        .eq("channel", "sms")
        .maybeSingle();
      if (configurationError) {
        console.error("[unifiedMessaging.saveTemplate] configuration lookup failed", {
          code: configurationError.code,
          message: configurationError.message,
        });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر التحقق من إعدادات SMS قبل حفظ تفضيل الفاتورة؛ لم يُحفظ القالب." });
      }
      if (!smsConfiguration) invoiceStyleToPersist = null;
    }

    const { data, error } = await admin.rpc("powerhub_unified_messaging_upsert_template_v2", {
      p_id: input.id ?? null, p_tenant_id: access.tenantId, p_name: input.name, p_description: input.description ?? null,
      p_channel: input.channel, p_event_type: input.eventType ?? null, p_body: input.body, p_variables: input.variables,
      p_is_active: input.isActive, p_actor_user_id: ctx.user.id, p_invoice_style: invoiceStyleToPersist,
    });
    if (error) {
      console.error("[unifiedMessaging.saveTemplate] template RPC failed", {
        code: error.code, message: error.message, details: error.details, hint: error.hint,
        tenantId: access.tenantId, siteId: input.siteId,
      });
      const errorText = `${error.code ?? ""} ${error.message ?? ""}`.toUpperCase();
      if (errorText.includes("TEMPLATE_NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message: "القالب المطلوب تعديله لم يعد موجودًا. حدّث القائمة ثم اختر القالب من جديد." });
      if (errorText.includes("TEMPLATE_OUT_OF_SCOPE")) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن تعديل قالب تابع لمساحة أخرى." });
      if (errorText.includes("INVALID_TEMPLATE_NAME")) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم القالب يجب أن يكون بين حرفين و120 حرفًا." });
      if (errorText.includes("INVALID_TEMPLATE_BODY")) throw new TRPCError({ code: "BAD_REQUEST", message: "نص القالب فارغ أو يتجاوز الحد المسموح." });
      if (errorText.includes("PGRST202") || errorText.includes("SCHEMA CACHE") || errorText.includes("FUNCTION PUBLIC.POWERHUB_UNIFIED_MESSAGING_UPSERT_TEMPLATE_V2")) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "إجراء حفظ القالب غير متاح في قاعدة البيانات الحالية. يلزم تطبيق تحديثات قاعدة بيانات مركز المراسلات." });
      }
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر حفظ قالب المراسلة الموحدة. سُجّل سبب الخطأ للتشخيص دون تسجيل نص القالب أو بيانات المشتركين." });
    }
    const id = Number(Array.isArray(data) ? data[0]?.powerhub_unified_messaging_upsert_template_v2 ?? data[0]?.id : data);
    if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تُعد قاعدة البيانات معرف القالب." });
    await writeSupabaseAudit({
      userId: ctx.user.id, tenantId: access.tenantId, siteId: input.siteId,
      entityType: "message_template", entityId: String(id), action: input.id ? "update" : "create",
      afterData: { id, channel: input.channel, eventType: input.eventType, isActive: input.isActive, invoiceStyle: invoiceStyleToPersist, invoiceStyleRequested: input.invoiceStyle ?? null },
    });
    return { id, invoiceStylePersisted: !wantsInvoiceStyle || invoiceStyleToPersist !== null };
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
    triggerConfig:z.object({afterDueHours:z.number().int().min(0).max(2160).optional(),afterDueDays:z.number().int().min(0).max(90).optional(),minBalance:z.number().min(0).optional()}).default({}), enabled:z.boolean().default(true),
  })).mutation(async ({ctx,input})=>{
    const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner"],"manageMessaging");
    if(input.id) {
      const {data:existingAutomation,error:existingAutomationError}=await supabaseAdmin().from("powerhub_message_automations")
        .select("event_type").eq("id",input.id).eq("tenant_id",access.tenantId).eq("site_id",input.siteId).maybeSingle();
      if(existingAutomationError) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر التحقق من حدث الأتمتة الحالية."});
      if(existingAutomation?.event_type==="invoice_issued" && input.eventType!=="invoice_issued") {
        throw new TRPCError({code:"BAD_REQUEST",message:"لا يمكن تغيير حدث أتمتة صدور الفاتورة؛ عطّلها أو أرشفها ثم أنشئ أتمتة مستقلة للحدث الآخر."});
      }
    }
    if(input.sendType==="manual") throw new TRPCError({code:"BAD_REQUEST",message:"الإرسال اليدوي لا يُحفظ كأتمتة؛ استخدم حملة يدوية."});
    
    const {data,error}=await supabaseAdmin().rpc("powerhub_unified_messaging_upsert_automation_v2",{
      p_id:input.id??null,p_tenant_id:access.tenantId,p_site_id:input.siteId,p_template_id:input.templateId,p_name:input.name,p_event_type:input.eventType,
      p_send_type:input.sendType,p_schedule_type:input.scheduleType,p_schedule_anchor_at:input.scheduleAnchorAt?.toISOString()??null,p_timezone:input.timezone,
      p_audience:input.audience,p_trigger_config:input.triggerConfig,p_enabled:input.enabled,p_actor_user_id:ctx.user.id,
    });
    if(error) throw new TRPCError({code:"BAD_REQUEST",message:"تعذر حفظ أتمتة المراسلة."});
    const id=Number(Array.isArray(data)?data[0]?.powerhub_unified_messaging_upsert_automation_v2??data[0]?.id:data);
    if(!id) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد قاعدة البيانات معرف الأتمتة."});
    if(input.eventType==="invoice_issued") {
      const {error:rescheduleError}=await supabaseAdmin().rpc("powerhub_reschedule_invoice_issued_automation",{
        p_tenant_id:access.tenantId,p_site_id:input.siteId,p_automation_id:id,
      });
      if(rescheduleError) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تم حفظ أتمتة الفواتير لكن تعذر تحديث توقيت الرسائل المعلقة."});
    }
    await writeSupabaseAudit({userId:ctx.user.id,tenantId:access.tenantId,siteId:input.siteId,entityType:"message_automation",entityId:String(id),action:input.id?"update":"create",afterData:{id,name:input.name,eventType:input.eventType,sendType:input.sendType,scheduleType:input.scheduleType,enabled:input.enabled}});
    return {id};
  }),

  setAutomationState: protectedProcedure.input(z.object({siteId:z.number().int().positive(),automationId:z.number().int().positive(),enabled:z.boolean(),archived:z.boolean().default(false)})).mutation(async({ctx,input})=>{
    const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner"],"manageMessaging");
    const admin=supabaseAdmin();
    const {data:existingAutomation,error:existingError}=await admin.from("powerhub_message_automations")
      .select("event_type").eq("id",input.automationId).eq("tenant_id",access.tenantId).eq("site_id",input.siteId).maybeSingle();
    if(existingError) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر التحقق من حدث الأتمتة الحالية."});
    if(!existingAutomation) throw new TRPCError({code:"NOT_FOUND",message:"الأتمتة غير موجودة ضمن الفرع المحدد."});
    const {data,error}=await admin.rpc("powerhub_unified_messaging_set_automation_state",{p_tenant_id:access.tenantId,p_site_id:input.siteId,p_automation_id:input.automationId,p_enabled:input.enabled,p_archived:input.archived,p_actor_user_id:ctx.user.id});
    if(error||!data?.[0]) throw new TRPCError({code:"BAD_REQUEST",message:"تعذر تغيير حالة الأتمتة."});
    if(existingAutomation.event_type==="invoice_issued") {
      const {error:rescheduleError}=await admin.rpc("powerhub_reschedule_invoice_issued_automation",{
        p_tenant_id:access.tenantId,p_site_id:input.siteId,p_automation_id:input.automationId,
      });
      if(rescheduleError) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تم تغيير حالة الأتمتة لكن تعذر تحديث توقيت الرسائل المعلقة."});
    }
    await writeSupabaseAudit({userId:ctx.user.id,tenantId:access.tenantId,siteId:input.siteId,entityType:"message_automation",entityId:String(input.automationId),action:input.archived?"archive":input.enabled?"enable":"disable",afterData:{enabled:input.enabled,archived:Boolean(data[0].archived_at)}});
    return {id:Number(data[0].id),enabled:Boolean(data[0].enabled),archived:Boolean(data[0].archived_at)};
  }),

  sendManualFreeText: protectedProcedure.input(z.object({
    siteId:z.number().int().positive(),
    recipientMode:z.enum(["subscriber","phone"]),
    subscriberId:z.number().int().positive().nullable(),
    phone:z.string().trim().max(80).default(""),
    message:z.string().trim().min(1).max(2000),
    operationId:z.string().uuid(),
  })).mutation(async({ctx,input})=>{
    const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner","manager","accountant"],"manageMessaging");
    if(input.recipientMode==="subscriber"&&!input.subscriberId) throw new TRPCError({code:"BAD_REQUEST",message:"اختر المشترك المراد إرسال الرسالة إليه."});
    if(input.recipientMode==="phone"&&input.subscriberId!==null) throw new TRPCError({code:"BAD_REQUEST",message:"أدخل رقم الهاتف فقط أو اختر مشتركاً، وليس كليهما."});
    let recipient=input.phone.trim();
    let subscriberId:number|null=null;
    if(input.recipientMode==="subscriber"){
      const {data:subscriber,error}=await supabaseAdmin().from("subscribers")
        .select("id,phone").eq("id",input.subscriberId!).eq("tenant_id",access.tenantId).eq("site_id",input.siteId).is("archived_at",null).maybeSingle();
      if(error||!subscriber) throw new TRPCError({code:"NOT_FOUND",message:"المشترك غير موجود ضمن الفرع المحدد."});
      if(!subscriber.phone) throw new TRPCError({code:"PRECONDITION_FAILED",message:"لا يوجد رقم هاتف مسجل لهذا المشترك."});
      recipient=String(subscriber.phone); subscriberId=Number(subscriber.id);
    }
    try { recipient = normalizeInternationalPhone(recipient); }
    catch(error) { throw new TRPCError({code:"BAD_REQUEST",message:error instanceof Error?error.message:"أدخل رقم هاتف بصيغة دولية صحيحة."}); }
    const {data:policy,error:policyError}=await supabaseAdmin().from("platform_settings").select("is_enabled,value").eq("setting_key","invoice_delivery_channels").maybeSingle();
    if(policyError) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر التحقق من تفعيل قناة SMS."});
    if(!policy?.is_enabled||(policy.value as any)?.smsEnabled===false) throw new TRPCError({code:"PRECONDITION_FAILED",message:"قناة SMS غير مفعلة حالياً."});
    const {data:account,error:accountError}=await supabaseAdmin().from("tenant_tweetsms_accounts")
      .select("is_active,api_endpoint,credential_ciphertext,credential_iv,sender_name")
      .eq("tenant_id",access.tenantId).maybeSingle();
    if(accountError) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر التحقق من ربط TweetSMS."});
    if(!account||!account.is_active||![account.api_endpoint,account.credential_ciphertext,account.credential_iv,account.sender_name].every((v:any)=>typeof v==="string"&&v.trim()))
      throw new TRPCError({code:"PRECONDITION_FAILED",message:"ربط TweetSMS غير جاهز؛ لم تُرسل الرسالة."});
    const {data:queued,error}=await supabaseAdmin().rpc("powerhub_prepare_manual_free_sms",{
      p_tenant_id:access.tenantId,p_site_id:input.siteId,p_subscriber_id:subscriberId,
      p_recipient:recipient,p_rendered_text:input.message.trim(),p_operation_id:input.operationId,p_actor_user_id:ctx.user.id,
    });
    if(error) {
      const code=String(error.message??"");
      if(code.includes("SMS_CHANNEL_DISABLED")) throw new TRPCError({code:"PRECONDITION_FAILED",message:"قناة SMS غير مفعلة حالياً."});
      if(code.includes("SUBSCRIBER_OUT_OF_SCOPE")) throw new TRPCError({code:"NOT_FOUND",message:"المشترك غير موجود ضمن الفرع المحدد."});
      throw new TRPCError({code:"PRECONDITION_FAILED",message:"تعذر تجهيز الرسالة اليدوية؛ راجع بيانات الإرسال وحاول مجدداً."});
    }
    const row=Array.isArray(queued)?queued[0]:queued;
    const notificationId=Number(row?.notification_id);
    if(!Number.isSafeInteger(notificationId)||notificationId<1) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم يُنشأ سجل الرسالة في طابور SMS."});
    if(row?.queued===false) {
      const {data:existing,error:existingError}=await supabaseAdmin().from("notification_messages")
        .select("id,status,last_error").eq("tenant_id",access.tenantId).eq("id",notificationId).maybeSingle();
      if(existingError||!existing) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل نتيجة الإرسال السابق."});
      if(existing.status==="pending") {
        const resumed=await processNotificationById(notificationId,ctx.user.id);
        return {notificationId,recipient,...resumed,replayed:true,queued:false};
      }
      return {notificationId,recipient,status:existing.status,error:existing.last_error??null,replayed:true,queued:false};
    }
    const dispatch=await processNotificationById(notificationId,ctx.user.id);
    return {notificationId,recipient,...dispatch,replayed:false,queued:true};
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

    if (row?.replayed) {
      // An idempotent replay may resume only notifications that are still pending.
      // A pending record has not claimed the provider dispatch lock; failed,
      // submitted and needs_review records are deliberately excluded here.
      const recipients = await supabaseAdmin().from("powerhub_message_campaign_recipients")
        .select("notification_id").eq("campaign_id", campaignId);
      if (recipients.error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل مستلمي الحملة السابقة؛ لم يبدأ الاستئناف."});
      const recipientIds = Array.from(new Set((recipients.data ?? [])
        .map((r:any)=>Number(r.notification_id)).filter((id:number)=>Number.isSafeInteger(id)&&id>0)));
      const pendingRows = recipientIds.length
        ? await supabaseAdmin().from("notification_messages").select("id")
            .eq("tenant_id",access.tenantId).eq("channel","sms").eq("status","pending").in("id",recipientIds)
        : {data:[],error:null};
      if (pendingRows.error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحديد الرسائل المعلّقة لاستكمال الحملة."});
      const pendingIds=(pendingRows.data??[]).map((r:any)=>Number(r.id)).filter((id:number)=>Number.isSafeInteger(id)&&id>0);
      const resumedResult=pendingIds.length
        ? await processNotificationIdsInBatches(access.tenantId,ctx.user.id,pendingIds)
        : {requested:0,submitted:0,failed:0,skipped:0,needsReview:0,reviewPersistenceFailed:0,results:[]};
      const current = await supabaseAdmin().rpc("powerhub_refresh_message_campaign", {
        p_tenant_id: access.tenantId, p_site_id: input.siteId, p_campaign_id: campaignId,
      });
      if (current.error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل نتيجة الحملة السابقة."});
      const replayRow = Array.isArray(current.data) ? current.data[0] : current.data;
      if (!replayRow) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد قاعدة البيانات نتيجة الحملة السابقة."});
      const liveCounts = await getCampaignDeliveryCounts(access.tenantId, input.siteId, campaignId);
      const previousAudit = await supabaseAdmin().from("audit_logs").select("metadata")
        .eq("tenant_id", access.tenantId).eq("site_id", input.siteId)
        .eq("entity_type", "message_campaign").eq("entity_id", String(campaignId))
        .eq("action", "send_manual").order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (previousAudit.error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر استرجاع تدقيق نتيجة الحملة السابقة."});
      const rawPreviousReviewFailed = Number((previousAudit.data?.metadata as any)?.reviewPersistenceFailed ?? 0);
      const previousReviewFailed = Number.isFinite(rawPreviousReviewFailed) ? Math.max(0,Math.trunc(rawPreviousReviewFailed)) : 0;
      const reviewPersistenceFailed = previousReviewFailed + countUnconfirmedNeedsReviewPersistence(resumedResult.results);
      const needsReview = effectiveNeedsReviewCount(replayRow.needs_review,resumedResult.results);
      await writeSupabaseAudit({
        userId:ctx.user.id,tenantId:access.tenantId,siteId:input.siteId,entityType:"message_campaign",
        entityId:String(campaignId),action:"send_manual_replay",
        metadata:{operationId:input.operationId,replayed:true,resumedPending:pendingIds.length,status:replayRow.status,
          submitted:resumedResult.submitted,failed:resumedResult.failed,skipped:resumedResult.skipped,needsReview,reviewPersistenceFailed},
      });
      // Preserve the idempotent result contract when there was nothing pending to resume.
      if (pendingIds.length === 0) {
        return {campaignId,operationId:input.operationId,status:liveCounts.pending + liveCounts.processing > 0 ? "processing" : liveCounts.status,
          requested:liveCounts.requested,submitted:liveCounts.submitted,failed:liveCounts.failed,skipped:liveCounts.skipped,
          pending:liveCounts.pending,processing:liveCounts.processing,needsReview:liveCounts.needsReview,
          reviewPersistenceFailed,results:[],replayed:true};
      }
      return {
        campaignId,operationId:input.operationId,status:liveCounts.pending + liveCounts.processing > 0 ? "processing" : liveCounts.status,
        requested:liveCounts.requested,submitted:liveCounts.submitted,failed:liveCounts.failed,skipped:liveCounts.skipped,
        pending:liveCounts.pending,processing:liveCounts.processing,needsReview:liveCounts.needsReview,
        reviewPersistenceFailed,results:resumedResult.results,replayed:true,resumedPending:pendingIds.length,
      };
    }

    const ids=await supabaseAdmin().from("powerhub_message_campaign_recipients").select("notification_id").eq("campaign_id",campaignId);
    if(ids.error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل مستلمي الحملة اليدوية؛ لم يبدأ الإرسال."});
    const notificationIds=(ids.data??[]).map((r:any)=>Number(r.notification_id)).filter(Number.isInteger);
    const result=notificationIds.length?await processNotificationIdsInBatches(access.tenantId,ctx.user.id,notificationIds):{requested:0,submitted:0,failed:0,skipped:0,needsReview:0,reviewPersistenceFailed:0,results:[]};
    const refreshed = await supabaseAdmin().rpc("powerhub_refresh_message_campaign", {
      p_tenant_id: access.tenantId, p_site_id: input.siteId, p_campaign_id: campaignId,
    });
    if (refreshed.error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحديث الحالة النهائية للحملة."});
    const finalRow = Array.isArray(refreshed.data) ? refreshed.data[0] : refreshed.data;
    if(!finalRow) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد قاعدة البيانات الحالة النهائية للحملة."});
    const liveCounts = await getCampaignDeliveryCounts(access.tenantId, input.siteId, campaignId);
    const needsReview = effectiveNeedsReviewCount(liveCounts.needsReview, result.results);
    const reviewPersistenceFailed = countUnconfirmedNeedsReviewPersistence(result.results);
    await writeSupabaseAudit({userId:ctx.user.id,tenantId:access.tenantId,siteId:input.siteId,entityType:"message_campaign",entityId:String(campaignId),action:"send_manual",metadata:{operationId:input.operationId,requested:input.subscriberIds.length,submitted:result.submitted,failed:result.failed,skipped:result.skipped,needsReview,reviewPersistenceFailed}});
    return {campaignId,operationId:input.operationId,status:liveCounts.pending + liveCounts.processing > 0 ? "processing" : liveCounts.status,requested:liveCounts.requested,submitted:liveCounts.submitted,failed:liveCounts.failed,skipped:liveCounts.skipped,pending:liveCounts.pending,processing:liveCounts.processing,needsReview:Math.max(liveCounts.needsReview,needsReview),reviewPersistenceFailed,results:result.results,replayed:false};
  }),
  history: protectedProcedure.input(z.object({
    siteId:z.number().int().positive(),
    period:z.enum(["cycle","today","custom"]).default("cycle"),
    startDate:z.string().refine(historyDateIsValid,"تاريخ غير صالح.").optional(),
    endDate:z.string().refine(historyDateIsValid,"تاريخ غير صالح.").optional(),
    type:z.enum(["all","invoice_issued","payment_reminder","payment_received","subscriber_reference","service_alert","manual","automatic"]).default("all"),
    channel:z.enum(["all","sms","whatsapp"]).default("all"),
    status:z.enum(["all","pending","processing","submitted","delivered","read","failed","needs_review"]).default("all"),
    search:z.string().trim().max(160).optional(),
    limit:z.number().int().min(10).max(100).default(50),
    offset:z.number().int().min(0).max(10000).default(0),
  })).query(async({ctx,input})=>{
    if(input.period==="custom"&&(!input.startDate||!input.endDate||input.startDate>input.endDate)){
      throw new TRPCError({code:"BAD_REQUEST",message:"حدد بداية ونهاية صحيحتين للفترة المخصصة."});
    }
    const access=await requireSupabaseSiteRole(ctx.user.id,input.siteId,["owner","manager","accountant","viewer"],"manageMessaging");
    const admin = supabaseAdmin();
    const rpcResult = await admin.rpc("powerhub_unified_messaging_history",{
      p_tenant_id:access.tenantId,p_site_id:input.siteId,p_period:input.period,
      p_start_date:input.period==="custom"?input.startDate:null,
      p_end_date:input.period==="custom"?input.endDate:null,
      p_type:input.type,p_channel:input.channel,p_status:input.status,p_search:input.search||null,
      p_limit:input.limit,p_offset:input.offset,
    });
    if (!rpcResult.error) {
      return rpcResult.data ?? {items:[],total:0,campaignCount:0,stats:{total:0,submitted:0,failed:0,pending:0,processing:0,needsReview:0,campaigns:0}};
    }
    const rpcCode = String((rpcResult.error as any).code ?? "");
    const rpcMessage = String((rpcResult.error as any).message ?? "");
    const historyRpcUnavailable = rpcCode === "PGRST202" || rpcCode === "42883"
      || /could not find the function .*powerhub_unified_messaging_history/i.test(rpcMessage);
    if (!historyRpcUnavailable) {
      throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل سجل الرسائل الموحد."});
    }
    // Production may not yet have the optional read-optimized RPC; the server-side fallback
    // applies the same tenant/site rules using existing tables and the canonical cycle RPC.
    return loadUnifiedMessageHistoryFromTables(admin, access.tenantId, input);
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
    if(campaign.error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر التحقق من نطاق الحملة."});
    if(!campaign.data) throw new TRPCError({code:"NOT_FOUND",message:"الحملة غير موجودة ضمن الفرع المحدد."});
    const rows=await supabaseAdmin().from("powerhub_message_campaign_recipients").select("notification_id").eq("campaign_id",input.campaignId);
    if(rows.error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحميل مستلمي الحملة؛ لم تبدأ إعادة المحاولة."});
    const ids=(rows.data??[]).map((r:any)=>Number(r.notification_id)).filter(Number.isInteger);
    const failed=ids.length
      ? await supabaseAdmin().from("notification_messages").select("id").eq("tenant_id",access.tenantId).in("id",ids).eq("status","failed")
      : {data:[],error:null};
    if(failed.error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحديد الرسائل الفاشلة؛ لم تبدأ إعادة المحاولة."});
    const failedIds=(failed.data??[]).map((r:any)=>Number(r.id)).filter(Number.isInteger);
    const result=failedIds.length?await processNotificationIdsInBatches(access.tenantId,ctx.user.id,failedIds):{requested:0,submitted:0,failed:0,skipped:0,needsReview:0,reviewPersistenceFailed:0,results:[]};
    const refreshed = await supabaseAdmin().rpc("powerhub_refresh_message_campaign", {
      p_tenant_id: access.tenantId, p_site_id: input.siteId, p_campaign_id: input.campaignId,
    });
    if (refreshed.error) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"تعذر تحديث نتيجة إعادة المحاولة."});
    const finalRow = Array.isArray(refreshed.data) ? refreshed.data[0] : refreshed.data;
    if(!finalRow) throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"لم تُعد قاعدة البيانات نتيجة إعادة المحاولة."});
    const requested=failedIds.length;
    const needsReview = effectiveNeedsReviewCount(finalRow.needs_review, result.results);
    const reviewPersistenceFailed = countUnconfirmedNeedsReviewPersistence(result.results);
    await writeSupabaseAudit({userId:ctx.user.id,tenantId:access.tenantId,siteId:input.siteId,entityType:"message_campaign",entityId:String(input.campaignId),action:"retry_failed",metadata:{requested,submitted:result.submitted,failed:result.failed,skipped:result.skipped,needsReview,reviewPersistenceFailed}});
    return {requested,submitted:result.submitted,failed:result.failed,skipped:result.skipped,needsReview,reviewPersistenceFailed,results:result.results,campaignStatus:finalRow.status};
  }),
});
