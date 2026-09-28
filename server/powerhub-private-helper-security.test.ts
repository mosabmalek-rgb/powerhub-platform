import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("powerhub_private auth helper grants", () => {
  it("keeps the internal helper schema unavailable to anon", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20260928190000_powerhub_private_helper_anon_hardening.sql"),
      "utf8",
    );
    expect(migration).toContain("revoke all on schema powerhub_private from public, anon;");
    expect(migration).toContain("grant usage on schema powerhub_private to authenticated, service_role;");
    expect(migration).toContain("revoke all on function powerhub_private.current_user_id() from public, anon;");
    expect(migration).toContain("revoke all on function powerhub_private.current_tenant_ids() from public, anon;");
    expect(migration).toContain("revoke all on function powerhub_private.is_platform_user() from public, anon;");
    expect(migration).toContain("grant execute on function powerhub_private.current_user_id() to authenticated, service_role;");
    expect(migration).toContain("grant execute on function powerhub_private.current_tenant_ids() to authenticated, service_role;");
    expect(migration).toContain("grant execute on function powerhub_private.is_platform_user() to authenticated, service_role;");
  });
});
