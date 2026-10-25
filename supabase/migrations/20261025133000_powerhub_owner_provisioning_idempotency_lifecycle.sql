-- Complete the owner-provisioning operation lifecycle used by the server:
-- reserve one stable request key, safely bind the Auth user, then complete the
-- SQL transaction. In an ambiguous Auth-create response, fail closed rather than
-- creating a second user.
ALTER TABLE public.generator_owner_provisioning_operations
  ADD COLUMN IF NOT EXISTS auth_creation_started_at timestamptz;

-- Keep a terminal tombstone after compensation so a retry can never reuse a
-- cancelled operation key or bind a deleted Auth identity to a new subscription.
ALTER TABLE public.generator_owner_provisioning_operations
  DROP CONSTRAINT IF EXISTS generator_owner_provisioning_operations_status_check;
ALTER TABLE public.generator_owner_provisioning_operations
  ADD CONSTRAINT generator_owner_provisioning_operations_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'completed'::text, 'cancelled'::text]));

CREATE OR REPLACE FUNCTION public.powerhub_guard_cancelled_owner_provisioning_operation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.status = 'cancelled' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'CANCELLED_PROVISIONING_OPERATION_IS_TERMINAL'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.powerhub_guard_cancelled_owner_provisioning_operation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_guard_cancelled_owner_provisioning_operation() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS powerhub_guard_cancelled_owner_provisioning_operation
  ON public.generator_owner_provisioning_operations;
CREATE TRIGGER powerhub_guard_cancelled_owner_provisioning_operation
BEFORE UPDATE ON public.generator_owner_provisioning_operations
FOR EACH ROW
EXECUTE FUNCTION public.powerhub_guard_cancelled_owner_provisioning_operation();

CREATE OR REPLACE FUNCTION public.powerhub_admin_begin_generator_owner_provisioning(
  p_actor_user_id bigint,
  p_client_operation_id uuid,
  p_owner_email text,
  p_request_fingerprint text
)
RETURNS TABLE(
  operation_status text,
  auth_user_id uuid,
  success boolean,
  tenant_id bigint,
  owner_user_id bigint,
  site_id bigint,
  subscription_id bigint,
  replayed boolean,
  can_create_auth boolean,
  needs_reconciliation boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_op public.generator_owner_provisioning_operations%rowtype;
  v_email text := lower(btrim(coalesce(p_owner_email, '')));
BEGIN
  SELECT platform_role INTO v_role
  FROM public.users
  WHERE id = p_actor_user_id
    AND role = 'admin'
    AND account_status = 'active'
    AND platform_role IN ('platform_owner', 'platform_admin');

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN_PLATFORM_ROLE' USING ERRCODE = '42501';
  END IF;
  IF p_client_operation_id IS NULL THEN
    RAISE EXCEPTION 'CLIENT_OPERATION_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF v_email = '' OR length(v_email) > 320 THEN
    RAISE EXCEPTION 'INVALID_OWNER_EMAIL' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_request_fingerprint, '') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'INVALID_PROVISIONING_FINGERPRINT' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('owner-provision:' || p_client_operation_id::text, 0));

  SELECT * INTO v_op
  FROM public.generator_owner_provisioning_operations
  WHERE client_operation_id = p_client_operation_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_op.actor_user_id IS DISTINCT FROM p_actor_user_id
       OR lower(v_op.owner_email) IS DISTINCT FROM v_email
       OR v_op.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
      RAISE EXCEPTION 'PROVISIONING_OPERATION_PAYLOAD_CONFLICT' USING ERRCODE = 'P0001';
    END IF;

    IF v_op.status = 'cancelled' THEN
      RETURN QUERY SELECT v_op.status, v_op.auth_user_id, false,
        v_op.tenant_id, v_op.owner_user_id, v_op.site_id, v_op.subscription_id,
        false, false, true;
      RETURN;
    END IF;

    IF v_op.status = 'completed' THEN
      RETURN QUERY SELECT v_op.status, v_op.auth_user_id, true,
        v_op.tenant_id, v_op.owner_user_id, v_op.site_id, v_op.subscription_id,
        true, false, false;
      RETURN;
    END IF;

    IF v_op.auth_user_id IS NOT NULL THEN
      RETURN QUERY SELECT v_op.status, v_op.auth_user_id, false,
        NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint,
        false, false, false;
      RETURN;
    END IF;

    -- A previous attempt marked Auth creation as started but did not persist the
    -- Auth ID. It might have created a user before losing the response; do not
    -- auto-create another user for the same operation.
    IF v_op.auth_creation_started_at IS NOT NULL THEN
      RETURN QUERY SELECT v_op.status, NULL::uuid, false,
        NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint,
        false, false, true;
      RETURN;
    END IF;

    UPDATE public.generator_owner_provisioning_operations
    SET auth_creation_started_at = now(), updated_at = now()
    WHERE client_operation_id = p_client_operation_id;

    RETURN QUERY SELECT 'pending'::text, NULL::uuid, false,
      NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint,
      false, true, false;
    RETURN;
  END IF;

  INSERT INTO public.generator_owner_provisioning_operations (
    client_operation_id, actor_user_id, owner_email, request_fingerprint,
    status, auth_creation_started_at, created_at, updated_at
  ) VALUES (
    p_client_operation_id, p_actor_user_id, v_email, p_request_fingerprint,
    'pending', now(), now(), now()
  );

  RETURN QUERY SELECT 'pending'::text, NULL::uuid, false,
    NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint,
    false, true, false;
END;
$function$;
ALTER FUNCTION public.powerhub_admin_begin_generator_owner_provisioning(bigint, uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_admin_begin_generator_owner_provisioning(bigint, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_begin_generator_owner_provisioning(bigint, uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_admin_attach_generator_owner_provisioning_auth(
  p_actor_user_id bigint,
  p_client_operation_id uuid,
  p_auth_user_id uuid,
  p_request_fingerprint text
)
RETURNS TABLE(attached boolean, auth_user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_op public.generator_owner_provisioning_operations%rowtype;
BEGIN
  SELECT platform_role INTO v_role
  FROM public.users
  WHERE id = p_actor_user_id
    AND role = 'admin'
    AND account_status = 'active'
    AND platform_role IN ('platform_owner', 'platform_admin');
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN_PLATFORM_ROLE' USING ERRCODE = '42501';
  END IF;
  IF p_auth_user_id IS NULL OR p_client_operation_id IS NULL THEN
    RAISE EXCEPTION 'PROVISIONING_AUTH_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_request_fingerprint, '') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'INVALID_PROVISIONING_FINGERPRINT' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('owner-provision:' || p_client_operation_id::text, 0));
  SELECT * INTO v_op
  FROM public.generator_owner_provisioning_operations
  WHERE client_operation_id = p_client_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROVISIONING_OPERATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_op.actor_user_id IS DISTINCT FROM p_actor_user_id
     OR v_op.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
    RAISE EXCEPTION 'PROVISIONING_OPERATION_PAYLOAD_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF v_op.status = 'completed' THEN
    IF v_op.auth_user_id IS DISTINCT FROM p_auth_user_id THEN
      RAISE EXCEPTION 'PROVISIONING_AUTH_USER_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT true, v_op.auth_user_id;
    RETURN;
  END IF;
  IF v_op.auth_user_id IS NOT NULL AND v_op.auth_user_id IS DISTINCT FROM p_auth_user_id THEN
    RAISE EXCEPTION 'PROVISIONING_AUTH_USER_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.generator_owner_provisioning_operations
  SET auth_user_id = p_auth_user_id, updated_at = now()
  WHERE client_operation_id = p_client_operation_id;
  RETURN QUERY SELECT true, p_auth_user_id;
END;
$function$;
ALTER FUNCTION public.powerhub_admin_attach_generator_owner_provisioning_auth(bigint, uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_admin_attach_generator_owner_provisioning_auth(bigint, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_attach_generator_owner_provisioning_auth(bigint, uuid, uuid, text) TO service_role;

-- Read the exact operation envelope after an indeterminate Auth-create response.
-- The caller still must match a server-owned app_metadata marker before attaching a user.
CREATE OR REPLACE FUNCTION public.powerhub_admin_get_generator_owner_provisioning_reconciliation(
  p_actor_user_id bigint,
  p_client_operation_id uuid,
  p_request_fingerprint text
)
RETURNS TABLE(
  operation_status text,
  owner_email text,
  auth_creation_started_at timestamptz,
  auth_user_id uuid,
  request_fingerprint text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_op public.generator_owner_provisioning_operations%rowtype;
BEGIN
  SELECT platform_role INTO v_role
  FROM public.users
  WHERE id = p_actor_user_id
    AND role = 'admin'
    AND account_status = 'active'
    AND platform_role IN ('platform_owner', 'platform_admin');
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN_PLATFORM_ROLE' USING ERRCODE = '42501';
  END IF;
  IF p_client_operation_id IS NULL
     OR coalesce(p_request_fingerprint, '') !~ '^[a-f0-9]{64}
CREATE OR REPLACE FUNCTION public.powerhub_admin_cancel_generator_owner_provisioning(
  p_actor_user_id bigint,
  p_client_operation_id uuid,
  p_request_fingerprint text,
  p_auth_user_id uuid DEFAULT NULL
)
RETURNS TABLE(cancelled boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_op public.generator_owner_provisioning_operations%rowtype;
BEGIN
  SELECT platform_role INTO v_role
  FROM public.users
  WHERE id = p_actor_user_id
    AND role = 'admin'
    AND account_status = 'active'
    AND platform_role IN ('platform_owner', 'platform_admin');
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN_PLATFORM_ROLE' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('owner-provision:' || p_client_operation_id::text, 0));
  SELECT * INTO v_op
  FROM public.generator_owner_provisioning_operations
  WHERE client_operation_id = p_client_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    -- A missing operation is not proof that the compensation gate succeeded.
    RETURN QUERY SELECT false;
    RETURN;
  END IF;
  IF v_op.actor_user_id IS DISTINCT FROM p_actor_user_id
     OR v_op.request_fingerprint IS DISTINCT FROM p_request_fingerprint
     OR v_op.status <> 'pending'
     OR v_op.auth_user_id IS DISTINCT FROM p_auth_user_id THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  UPDATE public.generator_owner_provisioning_operations
  SET status = 'cancelled', updated_at = now()
  WHERE client_operation_id = p_client_operation_id;
  RETURN QUERY SELECT true;
END;
$function$;
ALTER FUNCTION public.powerhub_admin_cancel_generator_owner_provisioning(bigint, uuid, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_admin_cancel_generator_owner_provisioning(bigint, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_cancel_generator_owner_provisioning(bigint, uuid, text, uuid) TO service_role;
 THEN
    RAISE EXCEPTION 'INVALID_PROVISIONING_RECONCILIATION_KEY' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_op
  FROM public.generator_owner_provisioning_operations
  WHERE client_operation_id = p_client_operation_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROVISIONING_OPERATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_op.actor_user_id IS DISTINCT FROM p_actor_user_id
     OR v_op.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
    RAISE EXCEPTION 'PROVISIONING_OPERATION_PAYLOAD_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY SELECT v_op.status, lower(v_op.owner_email),
    v_op.auth_creation_started_at, v_op.auth_user_id, v_op.request_fingerprint;
END;
$function$;
ALTER FUNCTION public.powerhub_admin_get_generator_owner_provisioning_reconciliation(bigint, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_admin_get_generator_owner_provisioning_reconciliation(bigint, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_get_generator_owner_provisioning_reconciliation(bigint, uuid, text) TO service_role;

-- Cancel only an uncompleted operation after a definite database/API rejection.
-- If the operation has completed or its identity does not match, preserve it.
CREATE OR REPLACE FUNCTION public.powerhub_admin_cancel_generator_owner_provisioning(
  p_actor_user_id bigint,
  p_client_operation_id uuid,
  p_request_fingerprint text,
  p_auth_user_id uuid DEFAULT NULL
)
RETURNS TABLE(cancelled boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_op public.generator_owner_provisioning_operations%rowtype;
BEGIN
  SELECT platform_role INTO v_role
  FROM public.users
  WHERE id = p_actor_user_id
    AND role = 'admin'
    AND account_status = 'active'
    AND platform_role IN ('platform_owner', 'platform_admin');
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN_PLATFORM_ROLE' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('owner-provision:' || p_client_operation_id::text, 0));
  SELECT * INTO v_op
  FROM public.generator_owner_provisioning_operations
  WHERE client_operation_id = p_client_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    -- A missing operation is not proof that the compensation gate succeeded.
    RETURN QUERY SELECT false;
    RETURN;
  END IF;
  IF v_op.actor_user_id IS DISTINCT FROM p_actor_user_id
     OR v_op.request_fingerprint IS DISTINCT FROM p_request_fingerprint
     OR v_op.status <> 'pending'
     OR v_op.auth_user_id IS DISTINCT FROM p_auth_user_id THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  UPDATE public.generator_owner_provisioning_operations
  SET status = 'cancelled', updated_at = now()
  WHERE client_operation_id = p_client_operation_id;
  RETURN QUERY SELECT true;
END;
$function$;
ALTER FUNCTION public.powerhub_admin_cancel_generator_owner_provisioning(bigint, uuid, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_admin_cancel_generator_owner_provisioning(bigint, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_cancel_generator_owner_provisioning(bigint, uuid, text, uuid) TO service_role;
