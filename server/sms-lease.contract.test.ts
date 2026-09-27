import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260927112000_powerhub_sms_lease_recovery.sql"),
  "utf8",
);
const worker = readFileSync(resolve(process.cwd(), "server/notification-worker.ts"), "utf8");

describe("SMS lease recovery contract", () => {
  it("adds bounded lease metadata and an index for SMS work", () => {
    expect(migration).toContain("add column if not exists lease_until timestamptz");
    expect(migration).toContain("add column if not exists claimed_by bigint");
    expect(migration).toContain("notification_messages_sms_lease_idx");
  });

  it("reclaims only expired processing rows with SKIP LOCKED", () => {
    expect(migration).toContain("status = 'processing'");
    expect(migration).toContain("lease_until is null or lease_until < now()");
    expect(migration).toContain("for update skip locked");
    expect(migration).toContain("status = 'pending'");
  });

  it("runs reclaim before the automatic due-message scan", () => {
    expect(worker).toContain('rpc("powerhub_reclaim_stale_sms_notifications"');
    expect(worker.indexOf("powerhub_reclaim_stale_sms_notifications")).toBeLessThan(worker.indexOf(".from(\"notification_messages\")"));
  });

  it("keeps the reclaim RPC internal", () => {
    expect(migration).toMatch(/revoke all on function public\.powerhub_reclaim_stale_sms_notifications\(integer\)/);
    expect(migration).toMatch(/grant execute on function public\.powerhub_reclaim_stale_sms_notifications\(integer\) to service_role/);
  });
});
