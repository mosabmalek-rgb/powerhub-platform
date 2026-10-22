import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const runtime = fs.readFileSync(path.join(root, "server/powerhub-unified-messaging.ts"), "utf8");
const notificationWorker = fs.readFileSync(path.join(root, "server/notification-worker.ts"), "utf8");
const manualFreeSmsMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261019090000_powerhub_free_manual_sms.sql"), "utf8");
const manualSmsHistoryScopeMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261019120000_powerhub_manual_sms_history_scope.sql"), "utf8");
const invoiceAutomationMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261020123000_powerhub_unify_invoice_issued_automation.sql"), "utf8");
const invoiceLinksMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261009223156_powerhub_invoice_message_links.sql"), "utf8");
const readingVariablesMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261014180000_powerhub_invoice_reading_message_variables.sql"), "utf8");
const manualReadingGuardMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261014190000_powerhub_manual_campaign_reading_token_guard.sql"), "utf8");
const totalBalanceMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261014200000_powerhub_total_subscriber_balance_message_variable.sql"), "utf8");
const tokenFixMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261010075617_powerhub_fix_postgres_urlsafe_tokens.sql"), "utf8");
const monthlyScheduleFixMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261010075643_powerhub_fix_monthly_schedule_day.sql"), "utf8");
const scheduler = fs.readFileSync(path.join(root, "server/_core/index.ts"), "utf8");
const ui = fs.readFileSync(path.join(root, "client/src/pages/MessagingSettingsPage.tsx"), "utf8");
const logo = fs.readFileSync(path.join(root, "client/src/components/PowerHubLogo.tsx"), "utf8");
const lightLogoWebp = fs.readFileSync(path.join(root, "client/public/brand-v1/powerhub-logo-light.webp"));
const darkLogoWebp = fs.readFileSync(path.join(root, "client/public/brand-v1/powerhub-logo-dark.webp"));
const sidebar = fs.readFileSync(path.join(root, "client/src/components/DashboardLayout.tsx"), "utf8");
const brandProxy = fs.readFileSync(path.join(root, "server/_core/storageProxy.ts"), "utf8");
const html = fs.readFileSync(path.join(root, "client/index.html"), "utf8");
const api = fs.readFileSync(path.join(root, "server/powerhub.ts"), "utf8");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20261009223234_powerhub_unified_messaging_runtime.sql"), "utf8");
const reminderMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261009223225_powerhub_payment_reminder_links.sql"), "utf8");
const deliveryUncertaintyMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261009223322_powerhub_sms_delivery_uncertainty.sql"), "utf8");
const subscriberCampaignFixMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261013120000_powerhub_fix_subscriber_update_and_manual_campaign.sql"), "utf8");
const smsQuotaSummaryMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261013130000_powerhub_admin_tweetsms_quota_summary.sql"), "utf8");
const campaignRefreshFixMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261013143000_powerhub_fix_campaign_result_refresh_ambiguity.sql"), "utf8");
const unifiedHistoryMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261013170000_powerhub_unified_message_history_filters.sql"), "utf8");
const adminReads = fs.readFileSync(path.join(root, "server/admin-runtime-reads.ts"), "utf8");
const adminUi = fs.readFileSync(path.join(root, "client/src/pages/AdminConsolePage.tsx"), "utf8");

const automationPolicy = fs.readFileSync(path.join(root, "server/unified-messaging-automation-policy.ts"), "utf8");

describe("unified messaging runtime contract", () => {
  it("has one protected scheduler for legacy invoice and unified automations", () => {
    expect(scheduler).toContain('app.all("/api/scheduled/process-invoice-notifications"');
    expect(scheduler).toContain("processUnifiedMessagingAutomations()");
    expect(scheduler).toContain("processAutomaticInvoiceNotifications()");
    expect(scheduler).toContain("processAutomaticFuelAlertEvaluation()");
    expect(notificationWorker).toContain('POWERHUB_ALLOW_PREVIEW_FUEL_ALERTS !== "true"');
    expect(notificationWorker).toContain('rpc("powerhub_inventory_evaluate_fuel_alerts"');
  });

  it("uses canonical campaigns and deterministic operation ids for manual sends", () => {
    expect(runtime).toContain("powerhub_prepare_manual_message_campaign");
    expect(runtime).toContain("processNotificationIdsInBatches");
    expect(runtime).toContain("slice(offset, offset + 50)");
    expect(runtime).toContain("operationId:z.string().uuid()");
    expect(migration).toContain("unique (tenant_id, site_id, operation_id)");
    expect(migration).toContain("unique (tenant_id, operation_key)");
    expect(migration).toContain("add column if not exists automation_id bigint");
    expect(migration).toContain("notification_messages_automation_runtime_idx");
  });

  it("patches every live invoice creation route to render previous reading, current reading, and consumption", () => {
    expect(readingVariablesMigration).toContain("powerhub_queue_invoice_sms_after_issue");
    expect(readingVariablesMigration).toContain("powerhub_queue_selected_invoice_sms");
    expect(readingVariablesMigration).toContain("powerhub_approve_and_issue_mobile_reading");
    expect(readingVariablesMigration).toContain("{{previous_reading}}");
    expect(readingVariablesMigration).toContain("{{current_reading}}");
    expect(readingVariablesMigration).toContain("{{consumption_kwh}}");
    expect(manualReadingGuardMigration).toContain("powerhub_prepare_manual_message_campaign");
    expect(manualReadingGuardMigration).toContain("previous_reading|current_reading|consumption_kwh");
    expect(ui).toContain('label: "القراءة السابقة"');
    expect(ui).toContain('label: "القراءة الحالية"');
    expect(ui).toContain('label: "الاستهلاك (ك.و.س)"');
    expect(ui).toContain('label: "الرصيد الإجمالي للمشترك"');
    expect(totalBalanceMigration).toContain("powerhub_queue_selected_invoice_sms");
    expect(totalBalanceMigration).toContain("powerhub_queue_invoice_sms_after_issue");
    expect(totalBalanceMigration).toContain("powerhub_approve_and_issue_mobile_reading");
    expect(totalBalanceMigration).toContain("{{total_balance}}");
    expect(runtime).toContain("loadSubscriberTotalBalances");
    expect(runtime).toContain('previous_reading: invoice?.previous_reading == null ? "" : String(invoice.previous_reading)');
  });

  it("records sanitized diagnostics when the unified automation scheduler cannot reclaim stale messages", () => {
    expect(runtime).toContain('logSafeSupabaseWorkerQueryFailure("unified-messaging", "stale-message reclaim", reclaimError)');
    expect(runtime).toContain('throw new Error("تعذر استرداد رسائل المراسلة الموحدة العالقة قبل بدء دورة الأتمتة.")');
    expect(runtime).toContain('logSafeSupabaseWorkerQueryFailure("unified-messaging", "enabled automation query", error)');
  });

  it("does not turn scheduler/template/portal query errors into benign skips", () => {
    expect(runtime).toContain('if (occurrence.error) throw new Error("تعذر حساب موعد أتمتة المراسلة.")');
    expect(runtime).toContain('if (templateError) throw new Error("تعذر تحميل قالب أتمتة المراسلة.")');
    expect(runtime).toContain('if (portal.error) throw new Error("تعذر تحميل إعدادات بوابة المشترك.")');
  });

  it("resolves generated links before rendering template tokens in both automation paths", () => {
    expect(runtime).toContain("return renderAutomationTemplate(body, values, async");
    expect(runtime).toContain("const renderedText = await renderAutomationMessage(template.body, values");
    expect(runtime).toContain("const textBody = await renderAutomationMessage(template.body, values");
    expect(runtime).not.toContain('textBody.includes("{{invoice_link}}")');
  });

  it("uses one deduplicated tenant/site-scoped message stream with real cycle and custom date filters", () => {
    expect(runtime).toContain("powerhub_unified_messaging_history");
    expect(runtime).toContain('period:z.enum(["cycle","today","custom"])');
    expect(runtime).toContain("p_start_date:input.period===\"custom\"?input.startDate:null");
    expect(unifiedHistoryMigration).toContain("public.powerhub_cycle_for_reading(p_tenant_id, p_site_id, now())");
    expect(unifiedHistoryMigration).toContain("p_period = 'today'");
    expect(unifiedHistoryMigration).toContain("p_period = 'custom'");
    expect(unifiedHistoryMigration).toContain("p_channel = 'all' or m.channel = p_channel");
    expect(unifiedHistoryMigration).toContain("m.tenant_id = p_tenant_id");
    expect(unifiedHistoryMigration).toContain("s.site_id = p_site_id");
    expect(unifiedHistoryMigration).toContain("i.site_id is null or i.site_id = p_site_id");
    expect(unifiedHistoryMigration).not.toContain("m.payload ->> 'siteId' = p_site_id::text");
    expect(unifiedHistoryMigration).toContain("cr.notification_id = m.id");
    // Production fallback is limited to a missing/unpublished optional RPC; other DB errors fail closed.
    expect(runtime).toContain("loadUnifiedMessageHistoryFromTables(admin, access.tenantId, input)");
    expect(runtime).toContain('rpcCode === "PGRST202" || rpcCode === "42883"');
    expect(runtime).toContain("const HISTORY_MAX_ROWS = 50_000");
    expect(runtime).toContain("const HISTORY_ID_CHUNK_SIZE = 500;");
    expect(runtime).toContain('startDate:z.string().refine(historyDateIsValid,"تاريخ غير صالح.").optional()');
    expect(runtime).toContain('endDate:z.string().refine(historyDateIsValid,"تاريخ غير صالح.").optional()');
    expect(runtime).toContain("المنطقة الزمنية المضبوطة لهذا الفرع غير صالحة.");
    expect(runtime).toContain("localMidnightUtc(localStartDate, timeZone)");
    expect(runtime).toContain("if (subscriber && Number(subscriber.site_id) !== siteId) continue;");
    expect(runtime).toContain("if (invoice && Number(invoice.site_id) !== siteId) continue;");
    expect(runtime).toContain("if (campaign && Number(campaign.site_id) !== siteId) continue;");
    expect(runtime).toContain("Number(recipientLink.subscriber_id) !== Number(message.subscriber_id)");
    expect(runtime).toContain("cycleEndInclusive ? query.lte(\"created_at\", endAt) : query.lt(\"created_at\", endAt)");
    expect(ui).toContain("سجل الرسائل الموحد");
    expect(ui).toContain("هذه الدورة");
    expect(ui).toContain("مخصص: بداية ونهاية");
    expect(ui).toContain("الحملات اليدوية");
    expect(ui).toContain("needs_review");
    expect(ui).toContain("campaignCount");
  });

  it("site-scopes failed SMS rows before applying the result limit", () => {
    expect(api).toContain("subscribers!inner(site_id)");
    expect(api).toContain('.eq("subscribers.site_id", input.siteId)');
  });

  it("processes subscriber-created and payment-received automations in minute windows", () => {
    expect(automationPolicy).toContain('new Set(["subscriber_created", "payment_received", "invoice_overdue"])');
    expect(runtime).toContain("buildAutomaticOccurrenceKey(eventType, now)");
    expect(runtime).toContain('.like("occurrence_key", `event:${eventType}:%`)');
    expect(runtime).toContain('query = query.gte("created_at", eventScanSince)');
    expect(runtime).toContain('.gte("created_at", incrementalAutomaticEvent ? eventScanSince : new Date(automation.created_at).toISOString())');
  });

  it("deduplicates persisted operation keys before rendering links again", () => {
    expect(runtime).toContain("getPersistedOperationMap(paymentOperationKeys)");
    expect(runtime).toContain("getPersistedOperationMap(candidates.map((candidate) => candidate.operationKey))");
    expect(runtime).toContain("accountForExistingOperation(candidate.operationKey");
  });

  it("serializes active run claims across different occurrence keys", () => {
    expect(migration).toContain("pg_advisory_xact_lock(hashtextextended");
    expect(migration).toContain("occurrence_key<>p_occurrence_key");
    expect(migration).toContain("and lease_until>now()");
  });

  it("paginates overdue invoices and chooses only the newest eligible invoice per subscriber", () => {
    expect(runtime).toContain('.gt("id", lastInvoiceId).order("id", { ascending: true }).limit(500)');
    expect(runtime).toContain("isLaterOverdueInvoiceCandidate");
    expect(automationPolicy).toContain("export function isLaterOverdueInvoiceCandidate");
  });

  it("paginates enabled automations with a stable keyset cursor", () => {
    expect(runtime).toContain('.gt("id", lastAutomationId).order("id", { ascending: true }).limit(500)');
    expect(runtime).toContain("lastAutomationId = Number(rows[rows.length - 1].id)");
  });

  it("counts only rows for the current automation occurrence and counts previous rows as skipped", () => {
    expect(runtime).toContain('String(row.payload?.occurrenceKey ?? "") === String(occ.occurrence_key)');
    expect(runtime).toContain('skipped += operationKeys.filter((key)');
  });

  it("fences automation finalization by the active run lease and checks affected rows", () => {
    expect(migration).toContain("and status='processing'");
    expect(migration).toContain("and lease_until>now()");
    expect(migration).toContain("get diagnostics v_updated = row_count");
    expect(migration).toContain("AUTOMATION_RUN_LEASE_LOST");
  });

  it("creates a fresh subscriber query for each automation pagination page", () => {
    expect(runtime).toContain("const buildBaseQuery = () => admin.from(\"subscribers\")");
    expect(runtime).toContain('let query = buildBaseQuery().gt("id", lastSubscriberId)');
  });

  it("reconciles queued counts from persisted operation keys after replay", () => {
    expect(runtime).toContain('from("notification_messages")');
    expect(runtime).toContain('.in("operation_key", operationKeys)');
    expect(runtime).toContain("تعذر التحقق من رسائل الأتمتة المثبتة في الطابور.");
  });

  it("records a durable failed run when processing throws after claiming the occurrence", () => {
    expect(runtime).toContain('await finishRun("failed", requestedCount, queuedCount, skipped, 1, message);');
    expect(runtime.indexOf('await finishRun("completed", requestedCount, queuedCount, skipped, 0, null);'))
      .toBeLessThan(runtime.indexOf('} catch (error) {', runtime.indexOf("async function executeAutomation")));
    expect(runtime).toContain("Release the active lease with a durable failure outcome");
    expect(runtime).toContain("throw error;");
  });

  it("does not allow an automation run to report completion when finalization fails", () => {
    expect(runtime).toContain('async function finishRun(status: "completed" | "skipped" | "failed"');
    expect(runtime).toContain('if (result.error) throw new Error("تعذر تثبيت نتيجة دورة الأتمتة.");');
    expect(runtime).toContain('await finishRun("completed", requestedCount, queuedCount, skipped, 0, null);');
  });

  it("keeps recurring service alerts unique per occurrence while subscriber creation stays one-time", () => {
    expect(runtime).toContain('eventType === "service_alert"');
    expect(runtime).toContain(':occurrence:${occ.occurrence_key}');
    expect(runtime).toContain('automation:${automation.id}:subscriber:${subscriber.id}');
  });

  it("validates existing and concurrent manual-free SMS operation replays against full message identity", () => {
    expect(manualFreeSmsMigration.split("v_existing.subscriber_id is distinct from p_subscriber_id").length - 1).toBe(2);
    expect(manualFreeSmsMigration.split("v_existing.payload->>'manualFreeText' is distinct from 'true'").length - 1).toBe(2);
    expect(manualFreeSmsMigration).toContain("select n.* into v_existing");
    expect(manualFreeSmsMigration).toContain("OPERATION_ID_REUSED_WITH_DIFFERENT_MESSAGE");
    expect(manualFreeSmsMigration).toContain("on conflict (tenant_id, operation_key) do nothing");
    expect(manualFreeSmsMigration).toContain("public.powerhub_mark_sms_needs_review(bigint,bigint,integer,text,text)'::regprocedure");
  });

  it("supports automation lifecycle and replay-safe execution", () => {
    expect(runtime).toContain("setAutomationState");
    expect(runtime).toContain("powerhub_claim_unified_automation_run");
    expect(runtime).toContain("powerhub_finish_unified_automation_run");
    expect(runtime).toContain("invoice_overdue");
    expect(runtime).toContain("payment_received");
    expect(runtime).toContain("subscriber_created");
  });

  it("keeps tenant/site scope enforced server-side", () => {
    expect(runtime).toContain('requireSupabaseSiteRole(ctx.user.id,input.siteId');
    expect(migration).toContain("v_site_tenant");
    expect(migration).toContain("v_template_tenant");
    expect(migration).toContain("TEMPLATE_OUT_OF_SCOPE");
  });

  it("blocks invoice and payment SMS requeue when delivery is uncertain", () => {
    const invoiceRuntimeMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261009223234_powerhub_unified_messaging_runtime.sql"), "utf8");
    const paymentReminderMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261009223225_powerhub_payment_reminder_links.sql"), "utf8");
    expect(invoiceRuntimeMigration).toContain("v_existing.status in ('processing','submitted','delivered','read','needs_review')");
    expect(paymentReminderMigration).toContain("v_existing.status in ('processing', 'submitted', 'delivered', 'read', 'needs_review')");
  });

  it("scopes campaign counters to the campaign and returns its needs-review count", () => {
    expect(migration).toContain("where r.campaign_id=p_campaign_id");
    expect(migration).toContain("needs_review integer,completed_at timestamptz");
    expect(migration).toContain("v_needs_review,c.completed_at");
  });

  it("does not report a campaign as completed while delivery outcomes need review", () => {
    expect(migration).toContain("count(*) filter (where n.status='needs_review')::integer");
    expect(migration).toContain("when v_needs_review>0 then 'partial'");
  });

  it("counts needs_review in the authoritative SMS claim quota gate", () => {
    expect(deliveryUncertaintyMigration).toContain("and messages.status in ('processing', 'submitted', 'delivered', 'read', 'needs_review')");
    expect(deliveryUncertaintyMigration).toContain("revoke all on function public.powerhub_claim_sms_notification(bigint,bigint) from public, anon, authenticated");
    expect(deliveryUncertaintyMigration).toContain("grant execute on function public.powerhub_claim_sms_notification(bigint,bigint) to service_role");
  });

  it("uses a conflict-safe automation claim for concurrent occurrences", () => {
    expect(migration).toContain("on conflict (automation_id, occurrence_key) do nothing");
    expect(migration).toContain("returning id into v_id");
    expect(migration).toContain("return v_id is not null;");
  });

  it("locks internal runtime RPCs to service role only", () => {
    expect(migration).toContain("revoke execute on function public.powerhub_sync_invoice_sms_template");
    expect(migration).toContain("revoke execute on function public.powerhub_touch_unified_automation_run");
    expect(migration).toContain("grant execute on function public.powerhub_sync_invoice_sms_template");
    expect(migration).toContain("grant execute on function public.powerhub_touch_unified_automation_run");
    expect(migration).not.toContain("grant execute on function public.powerhub_sync_invoice_sms_template" + " to authenticated");
    expect(migration).not.toContain("grant execute on function public.powerhub_touch_unified_automation_run" + " to authenticated");
  });


  it("matches SQL monthly occurrences to the UI by skipping nonexistent calendar days", () => {
    expect(monthlyScheduleFixMigration).toContain("if v_day <= v_last_day then");
    expect(monthlyScheduleFixMigration).toContain("v_candidate_local := null;");
    expect(monthlyScheduleFixMigration).not.toContain("make_interval(days => least(v_day,v_last_day)-1)");
    expect(monthlyScheduleFixMigration).toContain("'monthly:' || to_char(v_candidate_local,'YYYY-MM-DD')");
  });

  it("uses PostgreSQL-supported URL-safe tokens for invoice and payment links", () => {
    const sources = [invoiceLinksMigration, reminderMigration, migration, tokenFixMigration];
    for (const source of sources) expect(source).not.toContain("'base64url'");
    const tokenExpression = "translate(encode(gen_random_bytes(24), 'base64'), '+/', '-_')";
    expect(invoiceLinksMigration).toContain(tokenExpression);
    expect(reminderMigration).toContain(tokenExpression);
    expect(migration).toContain(tokenExpression);
    expect(tokenFixMigration.split(tokenExpression).length - 1).toBeGreaterThanOrEqual(3);
  });

  it("uses the configurable public URL and operation-key index", () => {
    expect(migration).toContain("powerhub_public_base_url");
    expect(migration).toContain("notification_messages_operation_lookup_idx");
    expect(reminderMigration).toContain("powerhub_payment_public_base_url");
    expect(reminderMigration).toContain("operation_key = trim(p_operation_key)");
  });

  it("routes invoice_issued through the per-invoice enqueue path and validates retry campaign site scope", () => {
    expect(runtime).not.toContain('if(input.eventType==="invoice_issued") throw new TRPCError');
    expect(runtime).toContain('if (eventType === "invoice_issued") return');
    expect(ui).toContain('<option value="invoice_issued">صدور فاتورة</option>');
    expect(ui).not.toContain("AutoSendPolicyCard");
    expect(invoiceAutomationMigration).toContain("powerhub_enqueue_invoice_sms");
    expect(invoiceAutomationMigration).toContain("from public.powerhub_issue_invoice_from_reading(");
    expect(invoiceAutomationMigration).toContain("POWERHUB_MOBILE_APPROVAL_INVOICE_ISSUE_ANCHOR_NOT_FOUND");
    expect(invoiceAutomationMigration).toContain("powerhub_reschedule_invoice_issued_automation");
    expect(runtime).toContain('powerhub_reschedule_invoice_issued_automation');
    expect(invoiceAutomationMigration).toContain("powerhub_format_message_amount");
    expect(invoiceAutomationMigration).toContain("{{previous_reading}}");
    expect(invoiceAutomationMigration).toContain("{{current_reading}}");
    expect(invoiceAutomationMigration).toContain("{{consumption_kwh}}");
    expect(invoiceAutomationMigration).toContain("{{total_balance}}");
    expect(invoiceAutomationMigration).toContain("automation_id, payload, operation_key");
    expect(invoiceAutomationMigration).toContain("powerhub_invoice_issued_automation_per_site_uidx");
    expect(invoiceAutomationMigration).toContain("powerhub.invoice_notification_handled_by_rpc");
    expect(runtime).toContain('.eq("site_id",input.siteId).maybeSingle()');
    expect(runtime).toContain("الحملة غير موجودة ضمن الفرع المحدد.");
  });

  it("qualifies subscriber updated_at and manual campaign SQL output references", () => {
    expect(subscriberCampaignFixMigration).toContain("returning subscribers.updated_at into v_updated_at");
    expect(subscriberCampaignFixMigration).toContain("on conflict do nothing");
    expect(subscriberCampaignFixMigration).toContain("returning campaign.queued into queued");
  });

  it("derives the admin TweetSMS quota from the feature policy and actual monthly SMS segments", () => {
    expect(smsQuotaSummaryMigration).toContain("powerhub_resolve_tenant_feature_policy(requested.id, 'sms')");
    expect(smsQuotaSummaryMigration).toContain("sum(greatest(coalesce(messages.segment_count, 1), 1))");
    expect(smsQuotaSummaryMigration).toContain("messages.status in ('processing', 'submitted', 'delivered', 'read', 'needs_review')");
    expect(adminReads).toContain('admin.rpc("powerhub_admin_tweetsms_quota_summary"');
    expect(adminReads).not.toContain("usedThisMonth: 0");
    expect(adminReads).toContain("monthlyLimitMode");
  });

  it("keeps TweetSMS setup collapsed by default and removes the misleading editable quota", () => {
    expect(adminUi).toContain("<details key={account.tenantId}");
    expect(adminUi).not.toContain('name="monthlyLimit"');
    expect(adminUi).toContain("الحد الشهري الفعلي وفق سياسة الاشتراك والإضافات");
  });

  it("derives manual campaign result counts from live notification statuses", () => {
    expect(runtime).toContain("async function getCampaignDeliveryCounts");
    expect(runtime).toContain('select("id,status").eq("tenant_id",tenantId).eq("channel","sms").in("id",ids)');
    expect(runtime).toContain('pending: count(["pending","queued"])');
    expect(runtime).toContain('processing: count(["processing"])');
    expect(runtime).toContain('submitted: count(["submitted","delivered","read"])');
  });

  it("provides a safe read-only TweetSMS readiness indicator without exposing credentials", () => {
    const readiness = runtime.slice(runtime.indexOf("connectionReadiness:"), runtime.indexOf("templates:", runtime.indexOf("connectionReadiness:")));
    expect(readiness).toContain('select("api_endpoint,sender_name,credential_ciphertext,credential_iv,is_active,last_tested_at,last_error")');
    expect(readiness).toContain("الربط فعال وجاهز");
    expect(readiness).not.toContain("credential_ciphertext:");
  });

  it("serves lossless theme-specific WebP logos with original PNG fallbacks and supported provider statuses", () => {
    expect(logo).toContain("/brand-v1/powerhub-logo-light.webp?v=lossless-20261014");
    expect(logo).toContain('const LIGHT_LOGO_FALLBACK_URL = "/api/brand-assets/powerhub-logo-light.png";');
    expect(logo).toContain("/brand-v1/powerhub-logo-dark.webp?v=lossless-20261014");
    expect(logo).toContain('const DARK_LOGO_FALLBACK_URL = "/api/brand-assets/powerhub-logo-dark.png";');
    expect(brandProxy).toContain('const BRAND_ASSETS = new Set(["powerhub-logo-light.png", "powerhub-logo-dark.png"]); '.trim());
    expect(lightLogoWebp.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(lightLogoWebp.subarray(8, 12).toString("ascii")).toBe("WEBP");
    expect(darkLogoWebp.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(darkLogoWebp.subarray(8, 12).toString("ascii")).toBe("WEBP");
    expect(html).toContain('type="image/png"');
    expect(sidebar).toContain('icon: MessageSquareText, label: "مركز الرسائل"');
    expect(ui).toContain('<option value="submitted">مرسلة للمزود</option>');
    expect(ui).not.toContain('<option value="delivered">تم التسليم</option>');
    expect(ui).not.toContain('<option value="read">تمت القراءة</option>');
    expect(ui).toContain('if (channel === "sms" && ["submitted", "delivered", "read"].includes(value)) return "مرسلة للمزود";');
  });

  it("surfaces pending campaign counts and per-message dispatch errors in the UI", () => {
    expect(ui).toContain("lastManualResult.pending");
    expect(ui).toContain("lastManualResult.processing");
    expect(ui).toContain("سجل الرسائل الموحد");
    expect(ui).toContain("unifiedMessaging.history.useQuery");
    expect(ui).toContain("هذه الدورة");
    expect(ui).toContain("مخصص: بداية ونهاية");
    expect(ui).toContain("تفاصيل لم تُرسل");
    expect(ui).toContain("issues: (result.results ?? [])");
    expect(ui).toContain("معاينة الرسالة النهائية");
    expect(ui).toContain("segmentArabicSms(renderedPreview)");
  });

  it("qualifies every campaign column in the result refresh function", () => {
    expect(campaignRefreshFixMigration).toContain("select campaign.requested into v_requested");
    expect(campaignRefreshFixMigration).toContain("campaign.completed_at,now()");
    expect(campaignRefreshFixMigration).toContain("where campaign.id=p_campaign_id");
    expect(campaignRefreshFixMigration).toContain("revoke execute on function public.powerhub_refresh_message_campaign(bigint,bigint,bigint) from public,anon,authenticated");
  });

  it("keeps the optimized history RPC optional and makes its site-scope patch idempotent", () => {
    expect(manualSmsHistoryScopeMigration).toContain("to_regprocedure(");
    expect(manualSmsHistoryScopeMigration).toContain("if v_function_oid is null then");
    expect(manualSmsHistoryScopeMigration).toContain("Optional powerhub_unified_messaging_history RPC is absent");
    expect(manualSmsHistoryScopeMigration).toContain("information_schema.columns");
    expect(manualSmsHistoryScopeMigration).toContain("notification_messages.site_id is absent");
    expect(manualSmsHistoryScopeMigration).toContain("and (m.site_id is null or m.site_id = p_site_id)");
    expect(manualSmsHistoryScopeMigration).toContain("UNIFIED_MESSAGE_HISTORY_DIRECT_SITE_SCOPE_PATCH_FAILED");
    expect(manualSmsHistoryScopeMigration).toContain("already has direct-site scoping; nothing to patch");
  });

  it("resumes only pending rows on an idempotent manual campaign replay", () => {
    const replay = runtime.slice(runtime.indexOf("if (row?.replayed)"), runtime.indexOf("\n    const ids=", runtime.indexOf("if (row?.replayed)")));
    expect(replay).toContain('.eq("status","pending")');
    expect(replay).toContain("processNotificationIdsInBatches");
    expect(replay).toContain("resumedPending");
    expect(replay).not.toContain('.eq("status","failed")');
    expect(replay).not.toContain('.eq("status","needs_review")');
    expect(ui).toContain('if (result.status !== "processing") setManualOperationId(crypto.randomUUID());');
  });

  it("exposes real manual messaging controls in the UI", () => {
    expect(ui).toContain("إرسال يدوي");
    expect(ui).toContain("تحديد الظاهر");
    expect(ui).toContain("إرسال الحملة");
    expect(ui).toContain("إرسال SMS يدوي حر");
    expect(ui).toContain("إدخال رقم هاتف يدوي");
    expect(ui).toContain("sendManualFreeText");
    expect(runtime).toContain("sendManualFreeText: protectedProcedure");
    expect(runtime).toContain("powerhub_prepare_manual_free_sms");
    expect(runtime).toContain("normalizeInternationalPhone");
    expect(ui).toContain("crypto.randomUUID()");
    expect(ui).toContain("failed");
    expect(ui).toContain("تقدير للنص الحالي");
    expect(ui).toContain("{sms.characterCount} حرفاً · {sms.segmentCount} رسالة SMS");
  });
});
