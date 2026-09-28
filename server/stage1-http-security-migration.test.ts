import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("stage 1 HTTP security migration", () => {
  const sql = readFileSync("supabase/migrations/20260928130000_http_security_hardening.sql", "utf8");

  it("keeps rate-limit RPC server-only", () => {
    expect(sql).toContain("revoke all on function public.powerhub_http_rate_limit_consume");
    expect(sql).toContain("grant execute on function public.powerhub_http_rate_limit_consume");
    expect(sql).toContain("to service_role");
  });

  it("uses an atomic compare-and-swap refresh rotation", () => {
    expect(sql).toContain("where refresh_token_hash = p_old_refresh_token_hash");
    expect(sql).toContain("and revoked_at is null");
    expect(sql).toContain("and expires_at > p_now");
    expect(sql).toContain("returning id, user_id, tenant_id");
  });
});
