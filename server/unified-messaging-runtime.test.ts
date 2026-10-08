import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const runtime = fs.readFileSync(path.join(root, "server/powerhub-unified-messaging.ts"), "utf8");
const scheduler = fs.readFileSync(path.join(root, "server/_core/index.ts"), "utf8");
const ui = fs.readFileSync(path.join(root, "client/src/pages/MessagingSettingsPage.tsx"), "utf8");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20261008130000_powerhub_unified_messaging_runtime.sql"), "utf8");
const reminderMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261008110000_powerhub_payment_reminder_links.sql"), "utf8");

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
