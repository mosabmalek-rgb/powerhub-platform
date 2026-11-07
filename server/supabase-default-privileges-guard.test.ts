import { describe, expect, it } from "vitest";
import { findDangerousDefaultPrivilegeGrants } from "../scripts/check-supabase-default-privileges.mjs";

describe("Supabase default-privileges migration guard", () => {
  it("allows default-privilege revocations for browser roles", () => {
    const findings = findDangerousDefaultPrivilegeGrants([
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public",
      "  REVOKE ALL ON TABLES FROM anon, authenticated, service_role;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public",
      "  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, service_role;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres",
      "  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;",
    ].join("\n"), "safe-revocations.sql");

    expect(findings).toEqual([]);
  });

  it("rejects broad grants to anon, authenticated, or PUBLIC", () => {
    const findings = findDangerousDefaultPrivilegeGrants([
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public",
      "  GRANT ALL ON TABLES TO anon, authenticated;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public",
      "  GRANT EXECUTE ON FUNCTIONS TO PUBLIC;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public",
      '  GRANT USAGE, SELECT ON SEQUENCES TO "authenticated";',
    ].join("\n"), "unsafe-defaults.sql");

    expect(findings).toHaveLength(3);
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining("anon, authenticated"),
      expect.stringContaining("PUBLIC"),
      expect.stringContaining("authenticated"),
    ]);
  });

  it("rejects any attempt to edit Supabase-managed supabase_admin defaults", () => {
    const findings = findDangerousDefaultPrivilegeGrants([
      "ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public",
      "  REVOKE ALL ON TABLES FROM anon, authenticated;",
    ].join("\n"), "managed-role.sql");

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("Supabase-managed supabase_admin");
  });

  it("does not flag object-level grants or SQL examples inside comments", () => {
    const findings = findDangerousDefaultPrivilegeGrants([
      "-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT ALL ON TABLES TO anon;",
      "/*",
      "  ALTER DEFAULT PRIVILEGES FOR ROLE postgres",
      "  GRANT EXECUTE ON FUNCTIONS TO authenticated;",
      "*/",
      "REVOKE ALL ON TABLE public.internal_table FROM PUBLIC, anon, authenticated;",
      "GRANT SELECT ON TABLE public.tenant_table TO authenticated;",
      "GRANT EXECUTE ON FUNCTION private.rls_helper() TO authenticated;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public",
      "  GRANT ALL ON TABLES TO service_role;",
    ].join("\n"), "object-acls.sql");

    expect(findings).toEqual([]);
  });

  it("does not split default-privilege-looking text inside a dollar-quoted body", () => {
    const findings = findDangerousDefaultPrivilegeGrants([
      "DO $body$",
      "BEGIN",
      "  RAISE NOTICE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT ALL ON TABLES TO anon;';",
      "END;",
      "$body$;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public",
      "  REVOKE ALL ON TABLES FROM anon, authenticated;",
    ].join("\n"), "dollar-body.sql");

    expect(findings).toEqual([]);
  });
});
