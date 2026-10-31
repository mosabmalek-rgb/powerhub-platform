-- Adaptive Delta Refresh: server-only, payload-free Realtime invalidation.
-- The browser subscribes to private tenant/site or tenant/all topics. Realtime
-- only tells the browser to re-read its existing protected revision RPC; it
-- never carries operational rows, amounts, identifiers, or authorization data.

DO $preflight$
BEGIN
  IF to_regclass('public.powerhub_sync_scope_state') IS NULL
     OR to_regclass('public.sites') IS NULL
     OR to_regclass('public.tenant_members') IS NULL
     OR to_regclass('public.staff_profiles') IS NULL
     OR to_regclass('realtime.messages') IS NULL
     OR to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NULL
     OR to_regprocedure('private.powerhub_current_user_id()') IS NULL
     OR to_regprocedure('private.powerhub_is_platform_admin()') IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_ADAPTIVE_DELTA_REALTIME_DEPENDENCY_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid='public.powerhub_sync_scope_state'::regclass
      AND relrowsecurity=true
  ) THEN
    RAISE EXCEPTION 'POWERHUB_SYNC_SCOPE_STATE_RLS_MUST_REMAIN_ENABLED';
  END IF;
  IF has_table_privilege('anon','public.powerhub_sync_scope_state','SELECT')
     OR has_table_privilege('authenticated','public.powerhub_sync_scope_state','SELECT') THEN
    RAISE EXCEPTION 'POWERHUB_SYNC_SCOPE_STATE_MUST_REMAIN_SERVER_ONLY';
  END IF;
  IF NOT has_table_privilege('authenticated','realtime.messages','SELECT') THEN
    RAISE EXCEPTION 'POWERHUB_REALTIME_MESSAGES_SELECT_GRANT_MISSING';
  END IF;
END
$preflight$;

-- This helper deliberately mirrors the server access resolver's identity,
-- active membership, expiry, site assignment, global assignment, and suspension
-- checks. SECURITY DEFINER avoids recursive RLS on membership/profile tables.
CREATE OR REPLACE FUNCTION private.powerhub_realtime_can_read_delta_topic(
  p_tenant_id bigint,
  p_site_id bigint,
  p_tenant_all boolean
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id bigint;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id < 1
     OR p_tenant_all IS NULL
     OR (p_tenant_all AND p_site_id IS NOT NULL)
     OR (NOT p_tenant_all AND (p_site_id IS NULL OR p_site_id < 1)) THEN
    RETURN false;
  END IF;

  IF private.powerhub_is_platform_admin() THEN
    RETURN true;
  END IF;

  v_user_id := private.powerhub_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN false;
  END IF;

  IF NOT p_tenant_all AND NOT EXISTS (
    SELECT 1
    FROM public.sites s
    WHERE s.id = p_site_id
      AND s.tenant_id = p_tenant_id
  ) THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.tenant_members tm
    WHERE tm.tenant_id = p_tenant_id
      AND tm.user_id = v_user_id
      AND tm.is_active = true
      AND tm.membership_status = 'active'
      AND (tm.expires_at IS NULL OR tm.expires_at > now())
      AND (
        tm.role = 'owner'
        OR (
          p_tenant_all
          AND EXISTS (
            SELECT 1
            FROM public.staff_profiles sp
            WHERE sp.tenant_id = p_tenant_id
              AND sp.user_id = v_user_id
              AND sp.site_id IS NULL
              AND sp.is_active = true
              AND sp.role IN ('manager','accountant','viewer')
              AND NOT (
                sp.suspension_started_at IS NOT NULL
                AND sp.suspension_ends_at IS NOT NULL
                AND now() >= sp.suspension_started_at
                AND now() < sp.suspension_ends_at
              )
          )
        )
        OR (
          NOT p_tenant_all
          AND EXISTS (
            SELECT 1
            FROM (
              SELECT
                sp.suspension_started_at,
                sp.suspension_ends_at
              FROM public.staff_profiles sp
              WHERE sp.tenant_id = p_tenant_id
                AND sp.user_id = v_user_id
                AND sp.is_active = true
                AND (sp.site_id = p_site_id OR sp.site_id IS NULL)
              ORDER BY (sp.site_id = p_site_id) DESC NULLS LAST
              LIMIT 1
            ) selected_profile
            WHERE NOT (
              selected_profile.suspension_started_at IS NOT NULL
              AND selected_profile.suspension_ends_at IS NOT NULL
              AND now() >= selected_profile.suspension_started_at
              AND now() < selected_profile.suspension_ends_at
            )
          )
        )
      )
  );
END
$function$;
ALTER FUNCTION private.powerhub_realtime_can_read_delta_topic(bigint,bigint,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.powerhub_realtime_can_read_delta_topic(bigint,bigint,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.powerhub_realtime_can_read_delta_topic(bigint,bigint,boolean)
  TO authenticated;

-- Clients can only receive the invalidation marker. They cannot publish to this
-- topic: no INSERT policy is created. The topic is parsed strictly and resolved
-- against live membership/site assignment, never trusted as authorization.
DROP POLICY IF EXISTS powerhub_delta_revision_receive ON realtime.messages;
CREATE POLICY powerhub_delta_revision_receive
ON realtime.messages
FOR SELECT TO authenticated
USING (
  private = true
  AND extension = 'broadcast'
  AND CASE
    WHEN topic ~ '^powerhub:tenant:[1-9][0-9]{0,18}:site:[1-9][0-9]{0,18}$' THEN
      CASE
        WHEN split_part(topic, ':', 3)::numeric <= 9223372036854775807
          AND split_part(topic, ':', 5)::numeric <= 9223372036854775807 THEN
          private.powerhub_realtime_can_read_delta_topic(
            split_part(topic, ':', 3)::bigint,
            split_part(topic, ':', 5)::bigint,
            false
          )
        ELSE false
      END
    WHEN topic ~ '^powerhub:tenant:[1-9][0-9]{0,18}:all$' THEN
      CASE
        WHEN split_part(topic, ':', 3)::numeric <= 9223372036854775807 THEN
          private.powerhub_realtime_can_read_delta_topic(
            split_part(topic, ':', 3)::bigint,
            NULL,
            true
          )
        ELSE false
      END
    ELSE false
  END
);

-- One central trigger observes the server-owned cursor table. All existing
-- source appenders (readings, invoices, payments, expenses, inventory, fuel,
-- maintenance, HR, etc.) already advance this journal, so no parallel event
-- engine or per-table trigger fleet is needed.
CREATE OR REPLACE FUNCTION private.powerhub_broadcast_delta_scope_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
VOLATILE
AS $function$
DECLARE
  v_payload jsonb := jsonb_build_object('version', 1);
  v_site_topic text;
  v_tenant_topic text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.last_cursor IS NOT DISTINCT FROM OLD.last_cursor
     AND NEW.retained_from_cursor IS NOT DISTINCT FROM OLD.retained_from_cursor THEN
    RETURN NEW;
  END IF;

  v_site_topic := 'powerhub:tenant:' || NEW.tenant_id::text || ':site:' || NEW.site_id::text;
  v_tenant_topic := 'powerhub:tenant:' || NEW.tenant_id::text || ':all';

  -- The marker intentionally contains no row data or entity identifiers.
  PERFORM realtime.send(v_payload, 'powerhub_delta_changed', v_site_topic, true);
  PERFORM realtime.send(v_payload, 'powerhub_delta_changed', v_tenant_topic, true);
  RETURN NEW;
END
$function$;
ALTER FUNCTION private.powerhub_broadcast_delta_scope_revision() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.powerhub_broadcast_delta_scope_revision()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS powerhub_sync_scope_state_broadcast_delta
  ON public.powerhub_sync_scope_state;
CREATE TRIGGER powerhub_sync_scope_state_broadcast_delta
AFTER INSERT OR UPDATE OF last_cursor, retained_from_cursor
ON public.powerhub_sync_scope_state
FOR EACH ROW
EXECUTE FUNCTION private.powerhub_broadcast_delta_scope_revision();

-- The Realtime channel itself must be private. Keep the Supabase project-level
-- "Allow public access" setting disabled before production release.