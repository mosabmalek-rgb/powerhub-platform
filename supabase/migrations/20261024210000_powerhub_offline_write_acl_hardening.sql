-- Keep direct DML behind the server's audited, capability-checked RPC boundary.
-- Production already has these write grants revoked; this idempotently reconciles
-- staging's broader grants without changing SELECT/RLS behavior.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE public.invoices, public.offline_sync_operations, public.payments, public.subscribers
  FROM PUBLIC, anon, authenticated;

-- These RPCs accept an explicit p_user_id and are called by the trusted server.
-- They must not be directly executable by browser roles; preserve service_role access.
REVOKE EXECUTE ON FUNCTION public.powerhub_update_subscriber(
  bigint, bigint, bigint, bigint, text, text, text, text, text, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.powerhub_approve_payment_documentation(
  bigint, bigint, bigint, bigint
) FROM PUBLIC, anon, authenticated;
