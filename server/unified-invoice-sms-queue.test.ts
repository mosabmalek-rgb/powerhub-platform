import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("invoice SMS unified feature gate", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20260922140000_powerhub_unified_invoice_sms_queue_policy.sql"),
    "utf8",
  );

  it("checks unified SMS policy before queueing an invoice message", () => {
    expect(sql).toContain("powerhub_resolve_tenant_feature_policy(new.tenant_id, 'sms')");
    expect(sql).toContain("v_feature_policy.enabled");
    expect(sql).toContain("return new;");
  });
});
