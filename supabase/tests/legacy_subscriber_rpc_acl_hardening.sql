\set ON_ERROR_STOP on

-- Disposable PostgreSQL test only. Create the five legacy RPC signatures and
-- intentionally reproduce the unsafe PUBLIC/browser grants seen in production.
DO $roles$
BEGIN
  BEGIN CREATE ROLE anon nologin; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE authenticated nologin; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE service_role nologin; EXCEPTION WHEN duplicate_object THEN NULL; END;
END
$roles$;

CREATE OR REPLACE FUNCTION public.powerhub_change_subscriber_lifecycle(bigint,bigint,bigint,bigint,text,uuid)
RETURNS boolean LANGUAGE sql AS $fn$ SELECT true $fn$;
CREATE OR REPLACE FUNCTION public.powerhub_claim_expired_subscribers(integer)
RETURNS boolean LANGUAGE sql AS $fn$ SELECT true $fn$;
CREATE OR REPLACE FUNCTION public.powerhub_create_generator_owner_subscription(
  bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer,integer,boolean
)
RETURNS boolean LANGUAGE sql AS $fn$ SELECT true $fn$;
CREATE OR REPLACE FUNCTION public.powerhub_finalize_expired_subscriber_purge(bigint)
RETURNS boolean LANGUAGE sql AS $fn$ SELECT true $fn$;
CREATE OR REPLACE FUNCTION public.powerhub_reset_subscriber_purge_claim(bigint)
RETURNS boolean LANGUAGE sql AS $fn$ SELECT true $fn$;

GRANT EXECUTE ON FUNCTION public.powerhub_change_subscriber_lifecycle(bigint,bigint,bigint,bigint,text,uuid)
  TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_claim_expired_subscribers(integer)
  TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_create_generator_owner_subscription(bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer,integer,boolean)
  TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_finalize_expired_subscriber_purge(bigint)
  TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_reset_subscriber_purge_claim(bigint)
  TO PUBLIC, anon, authenticated, service_role;

\ir ../migrations/20261025211819_powerhub_legacy_subscriber_rpc_acl_hardening.sql

DO $assert_closed_acl$
DECLARE
  v_signature text;
  v_proc regprocedure;
  v_signatures text[] := ARRAY[
    'public.powerhub_change_subscriber_lifecycle(bigint,bigint,bigint,bigint,text,uuid)',
    'public.powerhub_claim_expired_subscribers(integer)',
    'public.powerhub_create_generator_owner_subscription(bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer,integer,boolean)',
    'public.powerhub_finalize_expired_subscriber_purge(bigint)',
    'public.powerhub_reset_subscriber_purge_claim(bigint)'
  ];
BEGIN
  FOREACH v_signature IN ARRAY v_signatures LOOP
    v_proc := to_regprocedure(v_signature);
    IF v_proc IS NULL THEN
      RAISE EXCEPTION 'LEGACY_SUBSCRIBER_RPC_MISSING: %', v_signature;
    END IF;
    IF has_function_privilege('anon',v_proc,'EXECUTE')
       OR has_function_privilege('authenticated',v_proc,'EXECUTE') THEN
      RAISE EXCEPTION 'LEGACY_SUBSCRIBER_RPC_BROWSER_EXECUTE_REMAINS: %', v_signature;
    END IF;
    IF has_function_privilege('service_role',v_proc,'EXECUTE') IS NOT TRUE THEN
      RAISE EXCEPTION 'LEGACY_SUBSCRIBER_RPC_SERVICE_GRANT_MISSING: %', v_signature;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(p.proacl) acl
      WHERE p.oid=v_proc AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
    ) THEN
      RAISE EXCEPTION 'LEGACY_SUBSCRIBER_RPC_PUBLIC_EXECUTE_REMAINS: %', v_signature;
    END IF;
  END LOOP;
END
$assert_closed_acl$;

-- Idempotence/reconciliation: deliberately widen the grants again and run the
-- migration a second time; it must restore the restricted ACL without duplicates.
GRANT EXECUTE ON FUNCTION public.powerhub_change_subscriber_lifecycle(bigint,bigint,bigint,bigint,text,uuid)
  TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_claim_expired_subscribers(integer)
  TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_create_generator_owner_subscription(bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer,integer,boolean)
  TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_finalize_expired_subscriber_purge(bigint)
  TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_reset_subscriber_purge_claim(bigint)
  TO PUBLIC, anon, authenticated;

\ir ../migrations/20261025211819_powerhub_legacy_subscriber_rpc_acl_hardening.sql

DO $assert_replay$
DECLARE
  v_signature text;
  v_proc regprocedure;
  v_signatures text[] := ARRAY[
    'public.powerhub_change_subscriber_lifecycle(bigint,bigint,bigint,bigint,text,uuid)',
    'public.powerhub_claim_expired_subscribers(integer)',
    'public.powerhub_create_generator_owner_subscription(bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer,integer,boolean)',
    'public.powerhub_finalize_expired_subscriber_purge(bigint)',
    'public.powerhub_reset_subscriber_purge_claim(bigint)'
  ];
BEGIN
  FOREACH v_signature IN ARRAY v_signatures LOOP
    v_proc := to_regprocedure(v_signature);
    IF v_proc IS NULL
       OR has_function_privilege('anon',v_proc,'EXECUTE')
       OR has_function_privilege('authenticated',v_proc,'EXECUTE')
       OR NOT has_function_privilege('service_role',v_proc,'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) acl
         WHERE p.oid=v_proc AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
       ) THEN
      RAISE EXCEPTION 'LEGACY_SUBSCRIBER_RPC_REPLAY_ACL_DRIFT: %', v_signature;
    END IF;
  END LOOP;
END
$assert_replay$;

SELECT 'legacy subscriber SECURITY DEFINER RPC ACLs are server-only and repeatable' AS result;
