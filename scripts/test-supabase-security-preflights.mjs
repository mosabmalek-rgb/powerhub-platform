import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Run only after the named synthetic fixture in the PG17 integration workflow.
// Every mutation below is rolled back; no target/project override is provided.
const groups = {
  finance: {
    database: "financial_fixture_membership_expiry_test",
    cases: [
      ["20261110091920_powerhub_financial_review_membership_expiry.sql",
        "ALTER TABLE public.tenant_members RENAME COLUMN expires_at TO unexpected_expiry;",
        "GL_FIXTURE_EXPIRY_DEPENDENCY_MISSING", "22023"],
      ["20261110091920_powerhub_financial_review_membership_expiry.sql",
        "ALTER FUNCTION public.powerhub_financial_gl_fixture_manifest_prepare(bigint,bigint,bigint) SET search_path=public;",
        "GL_FINANCIAL_REVIEW_SOURCE_DRIFT: public.powerhub_financial_gl_fixture_manifest_prepare(bigint,bigint,bigint)", "22023"],
      ["20261110091920_powerhub_financial_review_membership_expiry.sql",
        "ALTER FUNCTION public.powerhub_approve_payroll(bigint,bigint,bigint,bigint) SECURITY DEFINER;",
        "GL_FINANCIAL_REVIEW_SOURCE_DRIFT: public.powerhub_approve_payroll(bigint,bigint,bigint,bigint)", "22023"],
    ],
  },
  supplier: {
    database: "inventory_supplier_site_scope_test",
    cases: [
      ["20261107120000_powerhub_inventory_supplier_site_rls_scope.sql",
        "DROP FUNCTION private.powerhub_has_site_access(bigint,bigint) CASCADE;",
        "INVENTORY_SUPPLIER_SITE_SCOPE_HELPER_MISSING"],
      ["20261107150000_powerhub_supplier_browser_read_acl_revoke.sql",
        "ALTER TABLE public.suppliers DISABLE ROW LEVEL SECURITY;",
        "SUPPLIER_SERVER_ONLY_RLS_DISABLED: suppliers"],
      ["20261107150000_powerhub_supplier_browser_read_acl_revoke.sql",
        "REVOKE SELECT ON public.suppliers FROM service_role;",
        "SUPPLIER_SERVER_ONLY_SERVICE_READ_MISSING: suppliers"],
    ],
  },
  company: {
    database: "financial_site_rls_scope_test",
    cases: [
      ["20261107143819_powerhub_company_account_capability_search_path.sql",
        "ALTER FUNCTION private.powerhub_has_company_account_capability(bigint,bigint,text) SECURITY INVOKER;",
        "COMPANY_ACCOUNT_CAPABILITY_HELPER_NOT_SECURITY_DEFINER"],
      ["20261107143819_powerhub_company_account_capability_search_path.sql",
        "ALTER FUNCTION private.powerhub_has_company_account_capability(bigint,bigint,text) OWNER TO authenticated;",
        "COMPANY_ACCOUNT_CAPABILITY_HELPER_OWNER_CHANGED"],
      ["20261107143819_powerhub_company_account_capability_search_path.sql",
        "GRANT EXECUTE ON FUNCTION private.powerhub_has_company_account_capability(bigint,bigint,text) TO anon;",
        "COMPANY_ACCOUNT_CAPABILITY_BROWSER_EXECUTE_PRESENT"],
      ["20261107143819_powerhub_company_account_capability_search_path.sql",
        "REVOKE EXECUTE ON FUNCTION private.powerhub_has_company_account_capability(bigint,bigint,text) FROM service_role;",
        "COMPANY_ACCOUNT_CAPABILITY_REQUIRED_EXECUTE_MISSING"],
    ],
  },
  support: {
    database: "platform_support_identity_role_guard_test",
    cases: [
      ["20261107130443_powerhub_platform_support_identity_role_guard.sql",
        "DROP TABLE private.platform_capability_policies;",
        "POWERHUB_PLATFORM_SUPPORT_IDENTITY_DEPENDENCY_MISSING"],
      ["20261107130443_powerhub_platform_support_identity_role_guard.sql",
        "ALTER TABLE public.users RENAME COLUMN role TO historical_role;",
        "POWERHUB_PLATFORM_SUPPORT_IDENTITY_COLUMNS_MISSING"],
    ],
  },
  defaults: {
    database: "default_privileges_acl_guard_test",
    cases: [
      ["20261107150951_powerhub_public_default_privilege_hardening.sql",
        "CREATE SCHEMA unreviewed_test; CREATE FUNCTION unreviewed_test.f() RETURNS int LANGUAGE sql AS 'SELECT 1';",
        "POWERHUB_DEFAULT_PRIVILEGE_UNREVIEWED_POSTGRES_ROUTINE_SCHEMA"],
      ["20261107150951_powerhub_public_default_privilege_hardening.sql",
        "CREATE SCHEMA unreviewed_test; ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA unreviewed_test GRANT EXECUTE ON FUNCTIONS TO authenticated;",
        "POWERHUB_DEFAULT_PRIVILEGE_UNREVIEWED_FUNCTION_DEFAULT_SCHEMA"],
      ["20261107150951_powerhub_public_default_privilege_hardening.sql",
        "ALTER SCHEMA storage RENAME TO historical_storage;",
        "POWERHUB_DEFAULT_PRIVILEGE_REQUIRED_SCHEMA_OR_ROLE_MISSING"],
      ["20261107150951_powerhub_public_default_privilege_hardening.sql",
        "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM service_role;",
        "POWERHUB_SERVICE_ROLE_DEFAULT_GRANTS_CHANGED"],
    ],
  },
};
const group = groups[process.argv[2]];
assert.ok(group, "Select finance, supplier, company, support or defaults.");
assert.equal(process.env.PGHOST, "127.0.0.1");
assert.equal(process.env.PGDATABASE, group.database);
assert.match(process.env.PGPORT ?? "", /^\d+$/);
assert.ok(process.env.PGUSER);

for (const [file, setup, expected, sqlState = "P0001"] of group.cases) {
  const encoded = Buffer.from(readFileSync(new URL("../supabase/migrations/" + file, import.meta.url)))
    .toString("base64");
  const query = `BEGIN;
SET LOCAL statement_timeout='15s';
${setup}
DO $negative_control$
BEGIN
  BEGIN
    EXECUTE convert_from(decode('${encoded}','base64'),'UTF8');
    RAISE EXCEPTION 'EXPECTED_SECURITY_MIGRATION_REJECTION_MISSING';
  EXCEPTION WHEN SQLSTATE '${sqlState}' THEN
    IF SQLERRM <> '${expected}' THEN RAISE; END IF;
  END;
END
$negative_control$;
ROLLBACK;
SELECT 'SECURITY_PREFLIGHT_NEGATIVE_CONTROL_OK';`;
  const result = spawnSync("psql", ["-X", "-w", "-v", "ON_ERROR_STOP=1", "-At",
    "-h", process.env.PGHOST, "-p", process.env.PGPORT,
    "-U", process.env.PGUSER, "-d", group.database],
  { input: query, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.ok(result.stdout.includes("SECURITY_PREFLIGHT_NEGATIVE_CONTROL_OK"));
  console.log("PASS", expected);
}
