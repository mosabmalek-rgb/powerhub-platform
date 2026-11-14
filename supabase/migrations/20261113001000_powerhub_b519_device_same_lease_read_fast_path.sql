-- B5.19: Staging verified, request-accurate same-device fast path.
-- Prior: all authenticated requests serialized on one advisory lock and
-- rewrote the same user/device lock, even when no lease refresh was due.
-- Existing device ownership, 15-minute stale takeover and independent-device
-- rejection are preserved. An unexpired matching DB row is checked per call.
-- This uses SECURITY DEFINER only as before, with the existing service_role ACL.
-- Re-run transaction-local B5.19 regression before accepting.
DO $preflight$ BEGIN
 IF md5(pg_get_functiondef('public.powerhub_claim_user_device(uuid,uuid,timestamp with time zone)'::regprocedure))
   <> '53b1cf98808c8a615a74d909bb331813'
 THEN RAISE EXCEPTION 'B519_DEVICE_CLAIM_SOURCE_DRIFT'; END IF;
END $preflight$;
CREATE OR REPLACE FUNCTION public.powerhub_claim_user_device(p_user_id uuid, p_device_id uuid, p_lease_until timestamp with time zone)
 RETURNS TABLE(allowed boolean, locked_until timestamp with time zone, active_device_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_existing public.powerhub_user_device_locks%rowtype;
  v_stale boolean;
BEGIN
  -- B5.19: a fresh lease on the SAME device needs no exclusive transaction
  -- lock or WAL-producing heartbeat for each protected GET.
  -- This is a fresh PostgreSQL read on every call: not an authorization
  -- cache, not a cross-device bypass, not an extension of the lease.
  -- A different, stale or expired device still follows the original
  -- serializing advisory lock / row lock / heartbeat path below.
  IF p_lease_until IS NOT NULL AND p_lease_until > now() + interval '47 hours' THEN
    SELECT * INTO v_existing FROM public.powerhub_user_device_locks AS lock_row
    WHERE lock_row.user_id = p_user_id AND lock_row.device_id = p_device_id
      AND lock_row.locked_until > now() + interval '47 hours'
      AND lock_row.last_seen_at >= now() - interval '30 seconds';
    IF FOUND THEN
      RETURN QUERY SELECT true, v_existing.locked_until, v_existing.device_id;
      RETURN;
    END IF;
  END IF;
  -- Serialize first claims and concurrent device swaps even when no row exists yet.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text, 0)
  );

  SELECT *
    INTO v_existing
  FROM public.powerhub_user_device_locks
  WHERE user_id = p_user_id
  FOR UPDATE;

  v_stale := FOUND
    AND v_existing.locked_until > now()
    AND v_existing.device_id <> p_device_id
    AND coalesce(
      v_existing.last_seen_at,
      v_existing.updated_at,
      v_existing.created_at
    ) <= now() - interval '15 minutes';

  IF NOT FOUND
     OR v_existing.locked_until <= now()
     OR v_existing.device_id = p_device_id
     OR v_stale THEN
    INSERT INTO public.powerhub_user_device_locks (
      user_id, device_id, locked_until, last_seen_at, updated_at
    )
    VALUES (
      p_user_id, p_device_id, p_lease_until, now(), now()
    )
    ON CONFLICT (user_id) DO UPDATE
      SET device_id = excluded.device_id,
          locked_until = excluded.locked_until,
          last_seen_at = now(),
          updated_at = now();

    RETURN QUERY SELECT true, p_lease_until, p_device_id;
    RETURN;
  END IF;

  RETURN QUERY SELECT false, v_existing.locked_until, v_existing.device_id;
END;
$function$;
