import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const runtime = fs.readFileSync(path.join(root, "server/powerhub-unified-messaging.ts"), "utf8");
const scheduler = fs.readFileSync(path.join(root, "server/_core/index.ts"), "utf8");
const ui = fs.readFileSync(path.join(root, "client/src/pages/MessagingSettingsPage.tsx"), "utf8");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20261008130000_powerhub_unified_messaging_runtime.sql"), "utf8");
const reminderMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261008110000_powerhub_payment_reminder_links.sql"), "utf8");
const deliveryUncertaintyMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261008143000_powerhub_sms_delivery_uncertainty.sql"), "utf8");

describe("unified messaging runtime contract", () => {
  it("has one protected scheduler for legacy invoice and unified automations", () => {
    expect(scheduler).toContain('app.all("/api/scheduled/process-invoice-notifications"');
    expect(scheduler).toContain("processUnifiedMessagingAutomations()");
    expect(scheduler).toContain("processAutomaticInvoiceNotifications()");
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

  it("does not turn scheduler/template/portal query errors into benign skips", () => {
    expect(runtime).toContain('if (occurrence.error) throw new Error("تعذر حساب موعد أتمتة المراسلة.")');
    expect(runtime).toContain('if (templateError) throw new Error("تعذر تحميل قالب أتمتة المراسلة.")');
    expect(runtime).toContain('if (portal.error) throw new Error("تعذر تحميل إعدادات بوابة المشترك.")');
  });

  it("paginates overdue invoices and chooses the oldest outstanding invoice per subscriber", () => {
    expect(runtime).toContain('.gt("id", lastInvoiceId).order("id", { ascending: true }).limit(500)');
    expect(runtime).toContain('new Date(invoice.due_date).getTime() < new Date(previous.due_date).getTime()');
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
    const invoiceRuntimeMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261008130000_powerhub_unified_messaging_runtime.sql"), "utf8");
    const paymentReminderMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261008110000_powerhub_payment_reminder_links.sql"), "utf8");
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

  it("uses the configurable public URL and operation-key index", () => {
    expect(migration).toContain("powerhub_public_base_url");
    expect(migration).toContain("notification_messages_operation_lookup_idx");
    expect(reminderMigration).toContain("powerhub_payment_public_base_url");
    expect(reminderMigration).toContain("operation_key = trim(p_operation_key)");
  });

  it("rejects invoice_issued as a generic automation and validates retry campaign site scope", () => {
    expect(runtime).toContain('input.eventType==="invoice_issued"');
    expect(runtime).toContain("إصدار الفاتورة يُدار عبر مسار رسائل الفاتورة الموحد");
    expect(runtime).toContain('.eq("site_id",input.siteId).maybeSingle()');
    expect(runtime).toContain("الحملة غير موجودة ضمن الفرع المحدد.");
  });

  it("exposes real manual messaging controls in the UI", () => {
    expect(ui).toContain("إرسال يدوي");
    expect(ui).toContain("تحديد الظاهر");
    expect(ui).toContain("إرسال الحملة");
    expect(ui).toContain("crypto.randomUUID()");
    expect(ui).toContain("failed");
  });
});
