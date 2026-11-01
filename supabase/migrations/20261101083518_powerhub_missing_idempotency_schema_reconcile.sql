-- Reconcile production idempotency columns/indexes missing from Staging.
-- Additive and idempotent: existing rows remain valid because the new columns
-- are nullable, matching Production's deployed contract.

ALTER TABLE public.access_invitations
  ADD COLUMN IF NOT EXISTS client_operation_id text,
  ADD COLUMN IF NOT EXISTS request_fingerprint text;

CREATE UNIQUE INDEX IF NOT EXISTS access_invitations_client_operation_id_uidx
  ON public.access_invitations(client_operation_id)
  WHERE client_operation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS access_invitations_tenant_email_status_idx
  ON public.access_invitations(tenant_id, email, status);

ALTER TABLE public.custom_permission_roles
  ADD COLUMN IF NOT EXISTS client_operation_id text,
  ADD COLUMN IF NOT EXISTS request_fingerprint text;

CREATE UNIQUE INDEX IF NOT EXISTS custom_permission_roles_operation_uidx
  ON public.custom_permission_roles(tenant_id, created_by_user_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL;

ALTER TABLE public.platform_access_invitations
  ADD COLUMN IF NOT EXISTS client_operation_id text,
  ADD COLUMN IF NOT EXISTS request_fingerprint text;

CREATE UNIQUE INDEX IF NOT EXISTS platform_access_invitations_client_operation_id_uidx
  ON public.platform_access_invitations(client_operation_id)
  WHERE client_operation_id IS NOT NULL;
