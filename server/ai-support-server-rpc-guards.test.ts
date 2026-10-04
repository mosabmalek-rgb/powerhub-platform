import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const reconciliation = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261004130000_reconcile_ai_server_rpc_guards.sql"),
  "utf8",
);

describe("AI server RPC guard reconciliation", () => {
  it("keeps request-claim and rate-limit RPCs server-only through ACL", () => {
    expect(reconciliation).toContain(
      "revoke all on function public.chat_ai_claim_request(text,bigint,bigint,bigint,bigint,integer)",
    );
    expect(reconciliation).toMatch(
      /grant execute on function public\.chat_ai_claim_request\(text,bigint,bigint,bigint,bigint,integer\)\s+to service_role/,
    );
    expect(reconciliation).toContain(
      "revoke all on function public.chat_ai_rate_limit(bigint,integer,integer)",
    );
    expect(reconciliation).toMatch(
      /grant execute on function public\.chat_ai_rate_limit\(bigint,integer,integer\)\s+to service_role/,
    );
    expect(reconciliation).not.toContain("current_setting('request.jwt.claim.role'");
    expect(reconciliation).not.toContain("INTERNAL_ONLY");
  });

  it("retains claim lease and rate-limit bounds", () => {
    expect(reconciliation).toContain("p_lease_seconds < 10");
    expect(reconciliation).toContain("p_lease_seconds > 180");
    expect(reconciliation).toContain("p_limit < 1");
    expect(reconciliation).toContain("p_limit > 60");
    expect(reconciliation).toContain("p_window_seconds < 10");
    expect(reconciliation).toContain("p_window_seconds > 3600");
  });
});
