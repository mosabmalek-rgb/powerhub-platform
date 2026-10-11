import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prepareSubscriberImport } from "./client/src/lib/subscriber-import";

describe("opening subscriber readings contract", () => {
  it("keeps the opening-reading migration atomic and non-billable", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20260929150000_powerhub_opening_readings_individual_bulk.sql"),
      "utf8",
    );
    expect(migration).toContain("add column if not exists is_opening_baseline boolean not null default false");
    expect(migration).toContain("create trigger invoices_block_opening_baseline");
    expect(migration).toContain("OPENING_BASELINE_NOT_BILLABLE");
    expect(migration).toContain("powerhub_create_subscriber_with_opening_reading");
    expect(migration).toContain("p_tenant_id, v_subscriber_id, p_client_operation_id::text");
    expect(migration).not.toContain("meter_readings(site_id");
    expect(migration).toContain("powerhub_bulk_upsert_subscribers");
    expect(migration).toContain("powerhub_resolve_tenant_feature_policy");
    expect(migration).toContain("'subscriber_import'");
    expect(migration).toContain("'bulk_import'");
    expect(migration).toContain("format('%s:opening:%s',trim(p_client_operation_id),n)");
    expect(migration).toContain("p_request_fingerprint text");
    expect(migration).toContain("return query select out_created,out_updated,out_failed,false");
    expect(migration).toContain("returning id, subscriber_no into v_subscriber_id, v_subscriber_no");

    const ambiguityFix = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20260930000100_powerhub_opening_readings_individual_returning_ambiguity_fix.sql"),
      "utf8",
    );
    expect(ambiguityFix).toContain("returning id into v_subscriber_id");
    expect(ambiguityFix).not.toContain("returning id, subscriber_no into v_subscriber_id, v_subscriber_no");

    const bulkOperationTypeFix = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20260930000200_powerhub_opening_readings_bulk_operation_type_fix.sql"),
      "utf8",
    );
    expect(bulkOperationTypeFix).toContain("'subscriber_bulk_import'");
  });

  it("uses one atomic database operation for platform reading, approval and invoice issuance", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20261010190809_powerhub_platform_reading_auto_invoice_20261010.sql"),
      "utf8",
    );
    expect(migration).toContain("create or replace function public.powerhub_create_reading_and_issue_invoice");
    expect(migration).toContain("powerhub_approve_and_issue_mobile_reading");
    expect(migration).toContain("OPENING_BASELINE_NOT_BILLABLE");
    expect(migration).toContain("revoke execute on function public.powerhub_create_reading_and_issue_invoice");
    expect(migration).toContain("grant execute on function public.powerhub_create_reading_and_issue_invoice");
    expect(migration).not.toContain("OPENING_READING_OWNER_REQUIRED");
    expect(migration).not.toContain("create or replace function public.powerhub_create_subscriber_with_opening_reading");
    expect(migration).not.toContain("create or replace function public.powerhub_bulk_upsert_subscribers");
  });

  it("auto-approves historic opening baselines without issuing invoices", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20261010193500_powerhub_opening_baseline_auto_approval_backfill.sql"),
      "utf8",
    );
    expect(migration).toContain("OPENING_READING_REQUIRED");
    expect(migration).toContain("automatic_opening_baseline_approval");
    expect(migration).toContain("'invoiceIssued', false");
    expect(migration).toContain("Automatically approved % pending opening-baseline readings; no invoices were issued.");
    expect(migration).not.toContain("powerhub_issue_invoice_from_reading");
    expect(migration).not.toContain("delete from public.meter_readings");
  });

  it("uses the bigint-safe invoice SMS lock and prevents duplicate SMS from the approval RPC", () => {
    const lockFix = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20261010192201_powerhub_invoice_sms_advisory_lock_fix_20261010.sql"),
      "utf8",
    );
    expect(lockFix).toContain("hashtextextended(format('powerhub:invoice-sms:%s:%s'");
    expect(lockFix).not.toContain("pg_advisory_xact_lock(new.tenant_id,new.id)");

    const dedupeFix = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20261010192857_powerhub_invoice_sms_rpc_dedup_20261010.sql"),
      "utf8",
    );
    expect(dedupeFix).toContain("current_setting('powerhub.invoice_notification_handled_by_rpc', true)");
    expect(dedupeFix).toContain("set_config(''powerhub.invoice_notification_handled_by_rpc'', ''true'', true)");
    expect(dedupeFix).toContain("POWERHUB_MOBILE_APPROVAL_INSERT_ANCHOR_NOT_FOUND");
  });

  it("rejects invalid opening readings and accepts a valid baseline", () => {
    expect(prepareSubscriberImport([{
      sourceRow: 2,
      fullName: "مشترك اختبار",
      phone: "+970599000000",
      address: "",
      subscriptionType: "سكني",
      openingReading: "-1",
    }])[0].status).toBe("error");

    expect(prepareSubscriberImport([{
      sourceRow: 2,
      fullName: "مشترك اختبار",
      phone: "+970599000000",
      address: "",
      subscriptionType: "سكني",
      openingReading: "1250.500",
      openingReadingAt: "2026-09-29T10:00:00Z",
    }])[0].status).toBe("ready");
  });
});
