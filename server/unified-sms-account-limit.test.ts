import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("unified SMS account limit", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20260922134500_powerhub_unified_sms_account_limit_mirror.sql"),
    "utf8",
  );

  it("does not persist the client supplied monthly limit as authoritative", () => {
    expect(sql).toContain("v_effective_monthly_limit");
    expect(sql).toContain("monthly_limit = v_effective_monthly_limit");
    expect(sql).not.toContain("monthly_limit = p_monthly_limit");
  });

  it("requires SMS package eligibility before configuring the tenant account", () => {
    expect(sql).toContain("powerhub_resolve_tenant_feature_policy(p_tenant_id, 'sms')");
    expect(sql).toContain("SMS_FEATURE_NOT_AVAILABLE_IN_PACKAGE");
  });

  it("supports unified unlimited mode", () => {
    expect(sql).toContain("v_feature_policy.effective_limit_mode = 'unlimited'");
  });

  it("covers the SMS add-on and one-off top-up lifecycle migration", () => {
    const smsMigration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20261001210000_powerhub_sms_addon_and_topup_lifecycle.sql"),
      "utf8",
    );
    expect(smsMigration).toContain("addon_code='sms'");
    expect(smsMigration).toContain("platform_admin_approved_sms_topup");
    expect(smsMigration).toContain("SMS_SUBSCRIPTION_EXPIRED");
    expect(smsMigration).toContain("trg_powerhub_sync_sms_addon_end");
    expect(smsMigration).toContain("p_resource='sms'");
  });
});
