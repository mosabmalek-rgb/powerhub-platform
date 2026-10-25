-- Close legacy SECURITY DEFINER RPCs to browser roles.
-- These procedures are server-owned workflows; caller-supplied actor/user IDs
-- are not a substitute for authenticated authorization at the RPC boundary.
-- Preserve service_role execution used by server-side retention/admin jobs.
--
-- Some environments have already retired these legacy RPCs. Resolve each exact
-- signature first so this forward-only hardening remains deployable across staging
-- drift and production without creating overloads or failing on absent legacy APIs.

DO $legacy_subscriber_rpc_acl$
DECLARE
  v_signature text;
  v_function regprocedure;
  v_signatures text[] := ARRAY[
    'public.powerhub_change_subscriber_lifecycle(bigint,bigint,bigint,bigint,text,uuid)',
    'public.powerhub_claim_expired_subscribers(integer)',
    'public.powerhub_create_generator_owner_subscription(bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer,integer,boolean)',
    'public.powerhub_finalize_expired_subscriber_purge(bigint)',
    'public.powerhub_reset_subscriber_purge_claim(bigint)'
  ];
BEGIN
  FOREACH v_signature IN ARRAY v_signatures LOOP
    v_function := to_regprocedure(v_signature);
    IF v_function IS NOT NULL THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',
        v_function
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %s TO service_role',
        v_function
      );
    END IF;
  END LOOP;
END
$legacy_subscriber_rpc_acl$;
