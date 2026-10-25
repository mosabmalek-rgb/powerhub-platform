-- Close legacy SECURITY DEFINER RPCs to browser roles.
-- These procedures are server-owned workflows; their caller-supplied actor/user IDs
-- are not a substitute for authenticated authorization at the RPC boundary.
-- Preserve service_role execution used by the server-side retention/admin jobs.

REVOKE ALL ON FUNCTION public.powerhub_change_subscriber_lifecycle(bigint,bigint,bigint,bigint,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_change_subscriber_lifecycle(bigint,bigint,bigint,bigint,text,uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.powerhub_claim_expired_subscribers(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_claim_expired_subscribers(integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.powerhub_create_generator_owner_subscription(bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamp with time zone,integer,integer,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_create_generator_owner_subscription(bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamp with time zone,integer,integer,boolean)
  TO service_role;

REVOKE ALL ON FUNCTION public.powerhub_finalize_expired_subscriber_purge(bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_finalize_expired_subscriber_purge(bigint)
  TO service_role;

REVOKE ALL ON FUNCTION public.powerhub_reset_subscriber_purge_claim(bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_reset_subscriber_purge_claim(bigint)
  TO service_role;
