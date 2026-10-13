import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("unified SMS enforcement", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20260922133000_powerhub_unified_sms_enforcement.sql"),
    "utf8",
  );

  it("resolves SMS policy inside the database", () => {
    expect(sql).toContain("powerhub_resolve_tenant_feature_policy(v_message.tenant_id, 'sms')");
    expect(sql).toContain("v_feature_policy.effective_limit");
  });

  it("preserves segment-based accounting", () => {
    expect(sql).toContain("v_used_segments + v_segment_count");
    expect(sql).toContain("messages.segment_count");
  });

  it("blocks disabled SMS before provider dispatch", () => {
    expect(sql).toContain("SMS_FEATURE_DISABLED");
    expect(sql).toContain("TWEETSMS_ACCOUNT_NOT_ACTIVE");
  });

  it("qualifies tenant_id lookups in the SMS claim RPC to avoid PL/pgSQL output collisions", () => {
    const claimFix = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20261013170000_powerhub_fix_sms_claim_tenant_id_ambiguity.sql"),
      "utf8",
    );
    expect(claimFix).toContain("subscriber.tenant_id = v_message.tenant_id");
    expect(claimFix).toContain("account.tenant_id = v_message.tenant_id");
    expect(claimFix).not.toMatch(/where\\s+tenant_id\\s*=/i);
    expect(claimFix).toContain("revoke all on function public.powerhub_claim_sms_notification(bigint,bigint) from public, anon, authenticated");
    expect(claimFix).toContain("grant execute on function public.powerhub_claim_sms_notification(bigint,bigint) to service_role");
  });

  it("keeps the claim RPC privileged", () => {
    expect(sql).toContain("revoke execute on function public.powerhub_claim_sms_notification");
    expect(sql).toContain("grant execute on function public.powerhub_claim_sms_notification");
    expect(sql).toContain("to service_role");
  });
});
