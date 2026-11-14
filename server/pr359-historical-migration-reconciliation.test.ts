import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const records = JSON.parse(readFileSync(resolve(process.cwd(),
  "docs/security/pr359-migration-history-crosswalk-20261108.json"), "utf8"));

describe("PR #359 historical migration security reconciliation release gate", () => {
  it("retains all 28 source records and explicitly assesses the 26 remaining current catalogs", () => {
    expect(records.records).toHaveLength(28);
    const reviewed = records.records.filter((r: any) => r.live_object_reconciliation);
    expect(reviewed).toHaveLength(26);
    expect(new Set(reviewed.map((r: any) => r.name)).size).toBe(26);
    for (const record of reviewed) {
      expect(record.outcome).toBe("NOT_PROVEN");
      expect(record.live_object_reconciliation.status).toMatch(/^[A-Z_]+$/);
      expect(record.live_object_reconciliation.detail.length).toBeGreaterThan(50);
      expect(record.live_object_reconciliation.staging_historical_attribution).toBe(
        "NOT_PROVEN_UNLESS_PRIOR_INDEPENDENT_PROOF");
      expect(record.live_object_reconciliation.release_decision).toBe(
        "DO_NOT_REPLAY_HISTORICAL_SQL_OR_EDIT_SCHEMA_MIGRATIONS");
    }
  });

  it("fails if the known Staging/Production security and optional-RPC drifts are silently erased", () => {
    const status = (name: string) => records.records.find((r: any) =>
      r.name === name)?.live_object_reconciliation?.status;
    expect(status("chat_rls_security_v1")).toBe("CURRENT_POLICY_DRIFT");
    expect(status("chat_realtime_authorization_v1")).toBe("CURRENT_POLICY_DRIFT");
    expect(status("chat_storage_rls_v1")).toBe("CURRENT_POLICY_DRIFT");
    expect(status("chat_storage_grants_hardening_v1")).toBe("CURRENT_ACL_DRIFT_RLS_REQUIRED");
    expect(status("chat_staging_compatibility_v1")).toBe("CURRENT_ENVIRONMENT_DRIFT");
    expect(status("powerhub_unified_message_history_filters")).toBe("ENVIRONMENT_OPTIONAL_RPC_DRIFT");
    expect(status("powerhub_manual_sms_history_scope")).toBe("STAGING_CURRENT_GUARD_PRODUCTION_OPTIONAL");
    expect(status("powerhub_optional_generator_capacity")).toBe("CURRENT_COLUMN_CONSTRAINT_MATCH");
  });
});
