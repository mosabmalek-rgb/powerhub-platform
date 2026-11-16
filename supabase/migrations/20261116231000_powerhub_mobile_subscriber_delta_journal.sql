-- E51: commit-ordered, tenant-scoped mobile change journal. Source-only pending
-- protected staging migration approval. No secret or public Data API access.
CREATE TABLE IF NOT EXISTS public.mobile_subscriber_change_log (
  sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL,
  branch_id bigint NOT NULL,
  subscriber_id bigint NOT NULL,
  change_type text NOT NULL CHECK (change_type IN ('touch','leave')),
  old_reader_user_id bigint,
  new_reader_user_id bigint,
  changed_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE INDEX IF NOT EXISTS mobile_subscriber_changes_tenant_branch_seq_idx
  ON public.mobile_subscriber_change_log (tenant_id,branch_id,sequence_id);
CREATE INDEX IF NOT EXISTS mobile_subscriber_changes_tenant_time_idx
  ON public.mobile_subscriber_change_log (tenant_id,changed_at,sequence_id);
CREATE TABLE IF NOT EXISTS public.mobile_subscriber_retention_floor (
  tenant_id bigint PRIMARY KEY,
  floor_sequence_id bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.mobile_subscriber_change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mobile_subscriber_retention_floor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mobile_subscriber_change_log,public.mobile_subscriber_retention_floor
  FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.mobile_subscriber_change_log TO service_role;
GRANT SELECT,INSERT,UPDATE ON public.mobile_subscriber_retention_floor TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.mobile_subscriber_change_log_sequence_id_seq TO service_role;

-- A transactional per-tenant advisory lock is taken BEFORE allocating the next
-- sequence. It forces journal sequence ordering to follow commit ordering and
-- closes the classic uncommitted-sequence / highwater gap.
CREATE OR REPLACE FUNCTION public.powerhub_mobile_append_subscriber_change(
  p_tenant_id bigint, p_branch_id bigint, p_subscriber_id bigint,
  p_change_type text, p_old_reader bigint, p_new_reader bigint
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $journal$
BEGIN
  IF p_tenant_id IS NULL OR p_branch_id IS NULL OR p_subscriber_id IS NULL
    OR p_change_type NOT IN ('touch','leave') THEN
    RAISE EXCEPTION 'INVALID_MOBILE_CHANGE';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('powerhub.mobile.delta:'||p_tenant_id::text,0));
  INSERT INTO public.mobile_subscriber_change_log
    (tenant_id,branch_id,subscriber_id,change_type,old_reader_user_id,new_reader_user_id)
  VALUES (p_tenant_id,p_branch_id,p_subscriber_id,p_change_type,p_old_reader,p_new_reader);
END $journal$;

CREATE OR REPLACE FUNCTION public.powerhub_mobile_subscriber_change_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $trigger$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM public.powerhub_mobile_append_subscriber_change(
      OLD.tenant_id,OLD.site_id,OLD.id,'leave',OLD.assigned_reader_user_id,NULL);
    RETURN OLD;
  ELSIF TG_OP='INSERT' THEN
    PERFORM public.powerhub_mobile_append_subscriber_change(
      NEW.tenant_id,NEW.site_id,NEW.id,'touch',NULL,NEW.assigned_reader_user_id);
  ELSE
    IF (OLD.tenant_id,OLD.site_id) IS DISTINCT FROM (NEW.tenant_id,NEW.site_id) THEN
      PERFORM public.powerhub_mobile_append_subscriber_change(
        OLD.tenant_id,OLD.site_id,OLD.id,'leave',OLD.assigned_reader_user_id,NULL);
    END IF;
    PERFORM public.powerhub_mobile_append_subscriber_change(
      NEW.tenant_id,NEW.site_id,NEW.id,'touch',
      OLD.assigned_reader_user_id,NEW.assigned_reader_user_id);
  END IF;
  RETURN NEW;
END $trigger$;
DROP TRIGGER IF EXISTS powerhub_mobile_subscriber_changes ON public.subscribers;
CREATE TRIGGER powerhub_mobile_subscriber_changes
AFTER INSERT OR UPDATE OR DELETE ON public.subscribers
FOR EACH ROW EXECUTE FUNCTION public.powerhub_mobile_subscriber_change_trigger();

CREATE OR REPLACE FUNCTION public.powerhub_mobile_meter_change_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $trigger$
DECLARE s record;
BEGIN
  IF TG_OP='INSERT' THEN
    FOR s IN SELECT tenant_id,site_id,id,assigned_reader_user_id
      FROM public.subscribers WHERE id=NEW.subscriber_id
    LOOP
      PERFORM public.powerhub_mobile_append_subscriber_change(
        s.tenant_id,s.site_id,s.id,'touch',s.assigned_reader_user_id,s.assigned_reader_user_id);
    END LOOP;
  ELSIF TG_OP='DELETE' THEN
    FOR s IN SELECT tenant_id,site_id,id,assigned_reader_user_id
      FROM public.subscribers WHERE id=OLD.subscriber_id
    LOOP
      PERFORM public.powerhub_mobile_append_subscriber_change(
        s.tenant_id,s.site_id,s.id,'touch',s.assigned_reader_user_id,s.assigned_reader_user_id);
    END LOOP;
  ELSE
    FOR s IN SELECT DISTINCT tenant_id,site_id,id,assigned_reader_user_id
      FROM public.subscribers
      WHERE id=OLD.subscriber_id OR id=NEW.subscriber_id
    LOOP
      PERFORM public.powerhub_mobile_append_subscriber_change(
        s.tenant_id,s.site_id,s.id,'touch',s.assigned_reader_user_id,s.assigned_reader_user_id);
    END LOOP;
  END IF;
  RETURN NULL;
END $trigger$;
-- Use an AFTER trigger: changes to a reading's value, status, cycle or removal
-- refresh the subscriber projection even when the subscriber row is untouched.
DROP TRIGGER IF EXISTS powerhub_mobile_meter_changes ON public.meter_readings;
CREATE TRIGGER powerhub_mobile_meter_changes
AFTER INSERT OR UPDATE OR DELETE ON public.meter_readings
FOR EACH ROW EXECUTE FUNCTION public.powerhub_mobile_meter_change_trigger();

CREATE OR REPLACE FUNCTION public.powerhub_mobile_delta_fence(p_tenant_id bigint,p_branch_id bigint)
RETURNS TABLE(highwater bigint,retained_floor bigint,max_subscriber_id bigint)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fence$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('powerhub.mobile.delta:'||p_tenant_id::text,0));
  RETURN QUERY SELECT
    COALESCE((SELECT max(l.sequence_id) FROM public.mobile_subscriber_change_log l
              WHERE l.tenant_id=p_tenant_id),0)::bigint,
    COALESCE((SELECT f.floor_sequence_id FROM public.mobile_subscriber_retention_floor f
              WHERE f.tenant_id=p_tenant_id),0)::bigint,
    COALESCE((SELECT max(s.id) FROM public.subscribers s
              WHERE s.tenant_id=p_tenant_id AND s.site_id=p_branch_id),0)::bigint;
END $fence$;

-- Explicit admin/maintenance operation; deployment must schedule this before
-- assuming a 90-day retention SLA. Any cursor <= deleted floor must bootstrap.
CREATE OR REPLACE FUNCTION public.powerhub_mobile_prune_subscriber_changes(
  p_tenant_id bigint,p_retention_days integer DEFAULT 90
) RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $prune$
DECLARE removed_through bigint;
BEGIN
  IF p_retention_days < 90 THEN RAISE EXCEPTION 'MOBILE_MIN_RETENTION_90_DAYS'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('powerhub.mobile.delta:'||p_tenant_id::text,0));
  SELECT max(sequence_id) INTO removed_through
  FROM public.mobile_subscriber_change_log
  WHERE tenant_id=p_tenant_id AND changed_at < now()-make_interval(days=>p_retention_days);
  IF removed_through IS NULL THEN RETURN 0; END IF;
  DELETE FROM public.mobile_subscriber_change_log
    WHERE tenant_id=p_tenant_id AND sequence_id<=removed_through;
  INSERT INTO public.mobile_subscriber_retention_floor(tenant_id,floor_sequence_id)
  VALUES(p_tenant_id,removed_through)
  ON CONFLICT(tenant_id) DO UPDATE SET
    floor_sequence_id=GREATEST(public.mobile_subscriber_retention_floor.floor_sequence_id,EXCLUDED.floor_sequence_id),
    updated_at=now();
  RETURN removed_through;
END $prune$;

REVOKE ALL ON FUNCTION public.powerhub_mobile_append_subscriber_change(bigint,bigint,bigint,text,bigint,bigint)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_mobile_subscriber_change_trigger() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_mobile_meter_change_trigger() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_mobile_delta_fence(bigint,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_mobile_prune_subscriber_changes(bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_mobile_append_subscriber_change(bigint,bigint,bigint,text,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_mobile_delta_fence(bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_mobile_prune_subscriber_changes(bigint,integer) TO service_role;
-- Existing privileged SQL/trigger owners must retain invoker access.


-- Batched, site-scoped projection avoids an N+1 latest-reading query.
-- All tenant/site/technician predicates are repeated inside the SQL function
-- even when the API already validated the authenticated scope.
CREATE OR REPLACE FUNCTION public.powerhub_mobile_subscriber_projection(
  p_tenant_id bigint,
  p_branch_id bigint,
  p_user_id bigint,
  p_distribution_enabled boolean,
  p_subscriber_ids bigint[],
  p_cycle_start timestamptz,
  p_cycle_end timestamptz
) RETURNS TABLE(
  id bigint, subscriber_no text, full_name text, phone text, address text,
  branch_id bigint, last_reading text, last_reading_at timestamptz,
  has_reading_in_current_cycle boolean, cycle_reading_id bigint,
  cycle_reading_value text, cycle_reading_at timestamptz, cycle_reading_status text
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $projection$
  SELECT s.id,s.subscriber_no,s.full_name,s.phone,s.address,s.site_id,
    approved.reading_value::text,operational.reading_at,
    cycle.id IS NOT NULL,cycle.id,cycle.reading_value::text,cycle.reading_at,cycle.status
  FROM public.subscribers s
  LEFT JOIN LATERAL (
    SELECT m.reading_value FROM public.meter_readings m
    WHERE m.tenant_id=p_tenant_id AND m.subscriber_id=s.id AND m.status='approved'
    ORDER BY m.reading_at DESC,m.id DESC LIMIT 1
  ) approved ON TRUE
  LEFT JOIN LATERAL (
    SELECT m.reading_at FROM public.meter_readings m
    WHERE m.tenant_id=p_tenant_id AND m.subscriber_id=s.id AND m.status='approved'
      AND m.is_opening_baseline=false
    ORDER BY m.reading_at DESC,m.id DESC LIMIT 1
  ) operational ON TRUE
  LEFT JOIN LATERAL (
    SELECT m.id,m.reading_value,m.reading_at,m.status FROM public.meter_readings m
    WHERE m.tenant_id=p_tenant_id AND m.subscriber_id=s.id AND m.status<>'rejected'
      AND m.is_opening_baseline=false AND m.reading_at >= p_cycle_start
      AND m.reading_at <= p_cycle_end
    ORDER BY m.reading_at DESC,m.id DESC LIMIT 1
  ) cycle ON TRUE
  WHERE s.tenant_id=p_tenant_id AND s.site_id=p_branch_id
    AND s.id=ANY(p_subscriber_ids) AND s.service_status='active'
    AND s.archived_at IS NULL
    AND (NOT p_distribution_enabled OR s.assigned_reader_user_id=p_user_id)
  ORDER BY s.id
$projection$;
REVOKE ALL ON FUNCTION public.powerhub_mobile_subscriber_projection(
  bigint,bigint,bigint,boolean,bigint[],timestamptz,timestamptz
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_mobile_subscriber_projection(
  bigint,bigint,bigint,boolean,bigint[],timestamptz,timestamptz
) TO service_role;
CREATE INDEX IF NOT EXISTS mobile_reading_projection_latest_idx
  ON public.meter_readings(tenant_id,subscriber_id,reading_at DESC,id DESC)
  INCLUDE(status,is_opening_baseline);
