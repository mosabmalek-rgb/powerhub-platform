-- Pin the financial company-account capability SECURITY DEFINER helper to an
-- empty search_path. Its body already schema-qualifies every relation and
-- helper call; preserve the existing owner and the exact EXECUTE ACL contract.
DO $preflight$
DECLARE
  v_oid oid := pg_catalog.to_regprocedure(
    'private.powerhub_has_company_account_capability(bigint,bigint,text)'
  );
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'COMPANY_ACCOUNT_CAPABILITY_HELPER_MISSING';
  END IF;

  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc AS p WHERE p.oid=v_oid) THEN
    RAISE EXCEPTION 'COMPANY_ACCOUNT_CAPABILITY_HELPER_NOT_SECURITY_DEFINER';
  END IF;

  IF pg_catalog.pg_get_userbyid(
       (SELECT p.proowner FROM pg_catalog.pg_proc AS p WHERE p.oid=v_oid)
     ) <> 'postgres' THEN
    RAISE EXCEPTION 'COMPANY_ACCOUNT_CAPABILITY_HELPER_OWNER_CHANGED';
  END IF;

  IF pg_catalog.has_function_privilege('anon',v_oid,'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS routine
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           routine.proacl,
           pg_catalog.acldefault('f',routine.proowner)
         )
       ) AS acl
       WHERE routine.oid=v_oid
         AND acl.grantee=0
         AND acl.privilege_type='EXECUTE'
     ) THEN
    RAISE EXCEPTION 'COMPANY_ACCOUNT_CAPABILITY_BROWSER_EXECUTE_PRESENT';
  END IF;

  IF NOT pg_catalog.has_function_privilege('authenticated',v_oid,'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role',v_oid,'EXECUTE') THEN
    RAISE EXCEPTION 'COMPANY_ACCOUNT_CAPABILITY_REQUIRED_EXECUTE_MISSING';
  END IF;
END
$preflight$;

ALTER FUNCTION private.powerhub_has_company_account_capability(bigint,bigint,text)
  SET search_path TO '';

DO $postflight$
DECLARE
  v_oid oid := pg_catalog.to_regprocedure(
    'private.powerhub_has_company_account_capability(bigint,bigint,text)'
  );
  v_prosecdef boolean;
  v_proconfig text[];
  v_owner oid;
BEGIN
  IF v_oid IS NULL THEN
    RAISE E...[truncated]