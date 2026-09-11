import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const webhook = readFileSync(join(process.cwd(), "server/messaging-webhooks.ts"), "utf8");
const migration = readFileSync(join(process.cwd(), "supabase/migrations/20260911190000_powerhub_whatsapp_webhook_status_rpc.sql"), "utf8");

describe("WhatsApp webhook Supabase migration", () => {
  it("does not depend on Drizzle/MySQL", () => {
    expect(webhook).not.toContain("drizzle-orm");
    expect(webhook).not.toContain("../drizzle/schema");
    expect(webhook).not.toContain("getDb()");
    expect(webhook).toContain('from("tenant_messaging_configurations")');
    expect(webhook).toContain('rpc("powerhub_process_whatsapp_status"');
  });

  it("restricts the status RPC to service_role", () => {
    expect(migration).toContain("security definer");
    expect(migration).toContain("revoke all on function public.powerhub_process_whatsapp_status");
    expect(migration).toContain("grant execute on function public.powerhub_process_whatsapp_status");
    expect(migration).toContain("to service_role");
    expect(migration).toContain("nm.tenant_id = p_tenant_id");
    expect(migration).toContain("nm.provider_message_id = p_provider_message_id");
  });

  it("validates supported WhatsApp statuses", () => {
    expect(migration).toContain("submitted",);
    expect(migration).toContain("delivered");
    expect(migration).toContain("read");
    expect(migration).toContain("failed");
    expect(migration).toContain("INVALID_NOTIFICATION_STATUS");
  });
});
