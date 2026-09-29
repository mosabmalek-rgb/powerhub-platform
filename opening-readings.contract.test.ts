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
    expect(migration).toContain("p_request_fingerprint text");
    expect(migration).toContain("return query select out_created,out_updated,out_failed,false");
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
