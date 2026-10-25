-- Trigger functions are executed by PostgreSQL as part of table writes, not as a
-- browser-callable RPC. Revoke direct Data API execution while leaving triggers
-- attached and preserving the service role's explicit grant.
REVOKE EXECUTE ON FUNCTION public.powerhub_notify_admin_pending_request()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.powerhub_notify_field_sync_received()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.powerhub_notify_payment_documentation_request()
  FROM PUBLIC, anon, authenticated;
