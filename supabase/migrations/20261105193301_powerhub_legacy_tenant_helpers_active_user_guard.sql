-- Harden legacy tenant-scope helpers so every tenant-level RLS path
-- rejects disabled and locked accounts, not only expired memberships.
CREATE OR REPLACE FUNCTION powerhub_private.current_tenant_ids()
RETURNS bigint[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT coalesce(pg_catalog.array_agg(membership.tenant_id), '{}'::bigint[])
  FROM public.tenant_members membership
  JOIN public.users account ON account.id = membership.user_id
  WHERE account.auth_user_id = (SELECT auth.uid())
    AND account.account_status = 'active'
    AND membership.is_active = true
    AND membership.membership_status = 'active'
    AND (membership.expires_at IS NULL OR membership.expires_at > pg_catalog.now());
$function$;
ALTER FUNCTION powerhub_private.current_tenant_ids() OWNER TO postgres;
REVOKE ALL ON FUNCTION powerhub_private.current_tenant_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION powerhub_private.current_tenant_ids() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION powerhub_private.has_tenant_access(target_tenant_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT target_tenant_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.tenant_members membership
    JOIN public.users account ON account.id = membership.user_id
    WHERE membership.tenant_id = target_tenant_id
      AND account.auth_user_id = (SELECT auth.uid())
      AND account.account_status = 'active'
      AND membership.is_active = true
      AND membership.membership_status = 'active'
      AND (membership.expires_at IS NULL OR membership.expires_at > pg_catalog.now())
  );
$function$;
ALTER FUNCTION powerhub_private.has_tenant_access(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION powerhub_private.has_tenant_access(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION powerhub_private.has_tenant_access(bigint) TO authenticated;

COMMENT ON FUNCTION powerhub_private.current_tenant_ids() IS
  'Returns only active, unexpired tenant memberships for the current auth.uid() when the corresponding users.account_status is active.';
COMMENT ON FUNCTION powerhub_private.has_tenant_access(bigint) IS
  'Tenant RLS predicate requiring an active user account and an active, unexpired tenant membership for the current auth.uid().';

DO $assertions$
DECLARE v_owner text; v_current_config text[]; v_has_config text[];
BEGIN
  SELECT pg_catalog.pg_get_userbyid(proowner),proconfig
    INTO v_owner,v_current_config
  FROM pg_catalog.pg_proc
  WHERE oid='powerhub_private.current_tenant_ids()'::regprocedure;
  SELECT proconfig INTO v_has_config
  FROM pg_catalog.pg_proc
  WHERE oid='powerhub_private.has_tenant_access(bigint)'::regprocedure;
  IF v_owner <> 'postgres'
     OR NOT ('search_path=""' = ANY(coalesce(v_current_config,ARRAY[]::text[])))
     OR NOT ('search_path=""' = ANY(coalesce(v_has_config,ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'LEGACY_TENANT_HELPER_HARDENING_FAILED';
  END IF;
  IF has_function_privilege('anon','powerhub_private.current_tenant_ids()','EXECUTE')
     OR has_function_privilege('anon','powerhub_private.has_tenant_access(bigint)','EXECUTE')
     OR NOT has_function_privilege('authenticated','powerhub_private.current_tenant_ids()','EXECUTE')
     OR NOT has_function_privilege('authenticated','powerhub_private.has_tenant_access(bigint)','EXECUTE')
     OR NOT has_function_privilege('service_role','powerhub_private.current_tenant_ids()','EXECUTE')
     OR has_function_privilege('service_role','powerhub_private.has_tenant_access(bigint)','EXECUTE') THEN
    RAISE EXCEPTION 'LEGACY_TENANT_HELPER_ACL_FAILED';
  END IF;
END
$assertions$;
