-- Reconcile the production device-lock primitives used by auth.claimDevice,
-- auth.me and auth.releaseDevice. Some staging migration ledgers contain the
-- mobile-session migrations but lack this separate lock table and its RPCs.
-- This migration is safe on a database where the exact production objects exist.
CREATE TABLE IF NOT EXISTS public.powerhub_user_device_locks (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  locked_until timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $validate_device_lock_table$
DECLARE
  v_expected record;
BEGIN
  FOR v_expected IN
    SELECT * FROM (VALUES
      ('user_id', 'uuid'),
      ('device_id', 'uuid'),
      ('locked_until', 'timestamptz'),
      ('last_seen_at', 'timestamptz'),
      ('created_at', 'timestamptz'),
      ('updated_at', 'timestamptz')
    ) AS expected(column_name, udt_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'powerhub_user_device_locks'
        AND c.column_name = v_expected.column_name
        AND c.udt_name = v_expected.udt_name
        AND c.is_nullable = 'NO'
    ) THEN
      RAISE EXCEPTION 'POWERHUB_DEVICE_LOCK_SCHEMA_MISMATCH: column % is missing or incompatible',
        v_expected.column_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.powerhub_user_device_locks'::regclass
      AND c.contype = 'p'
      AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (user_id)'
  ) THEN
    RAISE EXCEPTION 'POWERHUB_DEVICE_LOCK_SCHEMA_MISMATCH: expected primary key on user_id';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.powerhub_user_device_locks'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'auth.users'::regclass
      AND position('ON DELETE CASCADE' IN pg_get_constraintdef(c.oid)) > 0
  ) THEN
    RAISE EXCEPTION 'POWERHUB_DEVICE_LOCK_SCHEMA_MISMATCH: expected auth.users cascade foreign key';
  END IF;
END
$validate_device_lock_table$;

ALTER TABLE public.powerhub_user_device_locks OWNER TO postgres;
ALTER TABLE public.powerhub_user_device_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.powerhub_user_device_locks FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.powerhub_user_device_locks TO service_role;
CREATE INDEX IF NOT EXISTS powerhub_user_device_locks_locked_until_idx
  ON public.powerhub_user_device_locks (locked_until);

CREATE OR REPLACE FUNCTION public.powerhub_claim_user_device(
  p_user_id uuid,
  p_device_id uuid,
  p_lease_until timestamptz
)
RETURNS TABLE(
  allowed boolean,
  locked_until timestamptz,
  active_device_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $claim_device$
DECLARE
  v_existing public.powerhub_user_device_locks%rowtype;
  v_stale boolean;
BEGIN
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
$claim_device$;

ALTER FUNCTION public.powerhub_claim_user_device(uuid, uuid, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_claim_user_device(uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_claim_user_device(uuid, uuid, timestamptz)
  TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_release_user_device(
  p_user_id uuid,
  p_device_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $release_device$
BEGIN
  DELETE FROM public.powerhub_user_device_locks
  WHERE user_id = p_user_id
    AND device_id = p_device_id;
  RETURN FOUND;
END;
$release_device$;

ALTER FUNCTION public.powerhub_release_user_device(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_release_user_device(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_release_user_device(uuid, uuid)
  TO service_role;
