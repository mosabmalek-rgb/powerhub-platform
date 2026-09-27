import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("P1 hot-path indexes", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20260927121000_powerhub_hot_path_indexes.sql"),
    "utf8",
  );

  it("covers tenant/site history ordering and tenant-scoped reading ordering", () => {
    expect(migration).toMatch(/invoices_tenant_site_issue_date_id_idx[\s\S]*tenant_id, site_id, issue_date desc, id desc/);
    expect(migration).toMatch(/payments_tenant_site_paid_at_id_idx[\s\S]*tenant_id, site_id, paid_at desc, id desc/);
    expect(migration).toMatch(/meter_readings_tenant_reading_at_id_desc_idx[\s\S]*tenant_id, reading_at desc, id desc/);
    expect(migration).toMatch(/expenses_tenant_site_occurred_at_id_idx[\s\S]*tenant_id, site_id, occurred_at desc, id desc/);
  });

  it("keeps the SMS queue index partial and aligned with claimable states", () => {
    expect(migration).toMatch(/notification_messages_tenant_due_queue_idx[\s\S]*tenant_id, channel, event_type, status, scheduled_at, id/);
    expect(migration).toMatch(/where channel = 'sms' and status in \('pending', 'processing', 'failed'\)/);
    expect(migration).not.toMatch(/create index concurrently/i);
  });
});
