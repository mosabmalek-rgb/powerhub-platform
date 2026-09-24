import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const webhook = readFileSync(join(process.cwd(), "server/messaging-webhooks.ts"), "utf8");
const migration = readFileSync(join(process.cwd(), "supabase/migrations/20260915173000_powerhub_whatsapp_webhook_status_rpc_v2.sql"), "utf8");

describe("WhatsApp webhook Supabase migration", () => {
  it("uses Supabase only and calls the status RPC", () => {
    expect(webhook).not.toContain("drizzle-orm");
    expect(webhook).not.toContain("../drizzle/schema");
    expect(webhook).not.toContain("getDb()");
    expect(webhook).toContain('from("tenant_messaging_configurations")');
    expect(webhook).toContain('rpc("powerhub_process_whatsapp_status"');
  });

  it("restricts the privileged status RPC to service_role", () => {
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = ''");
    expect(migration).not.toMatch(/create or replace function public\.powerhub_process_whatsapp_status[\s\S]*?security invoker/);
    expect(migration).toContain("revoke all on function public.powerhub_process_whatsapp_status");
    expect(migration).toContain("grant execute on function public.powerhub_process_whatsapp_status");
    expect(migration).toContain("to service_role");
  });

  it("validates statuses and prevents stale regressions", () => {
    expect(migration).toContain("INVALID_NOTIFICATION_STATUS");
    expect(migration).toContain("p_status = 'delivered' and nm.status = 'submitted'");
    expect(migration).toContain("p_status = 'read' and nm.status in ('submitted', 'delivered')");
    expect(migration).toContain("p_status = 'failed' and nm.status = 'submitted'");
  });
});
