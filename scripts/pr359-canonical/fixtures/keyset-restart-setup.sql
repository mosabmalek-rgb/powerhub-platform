-- PR359 CB-A: synthetic restart/rollback demonstration. Not canonical DDL.
-- Execute only inside the networkless disposable PostgreSQL Docker instance.
\set ON_ERROR_STOP on
CREATE TABLE public.pr359_synthetic_keyset_source (
  tenant_id bigint NOT NULL,
  site_id bigint NOT NULL,
  generator_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fuel_events','maintenance_work_orders')),
  event_id bigint NOT NULL CHECK (event_id > 0),
  PRIMARY KEY (tenant_id,site_id,generator_id,kind,event_id)
);
CREATE TABLE public.pr359_synthetic_keyset_checkpoint (
  tenant_id bigint NOT NULL,
  site_id bigint NOT NULL,
  generator_id bigint NOT NULL,
  kind text NOT NULL,
  cursor_id bigint NOT NULL DEFAULT 0,
  snapshot_upper_id bigint NOT NULL CHECK (snapshot_upper_id >= 0),
  PRIMARY KEY (tenant_id,site_id,generator_id,kind),
  CHECK (cursor_id <= snapshot_upper_id)
);
CREATE TABLE public.pr359_synthetic_keyset_sink (
  tenant_id bigint NOT NULL,
  site_id bigint NOT NULL,
  generator_id bigint NOT NULL,
  kind text NOT NULL,
  event_id bigint NOT NULL,
  PRIMARY KEY (tenant_id,site_id,generator_id,kind,event_id)
);

CREATE FUNCTION public.pr359_synthetic_keyset_page(
  p_tenant bigint, p_site bigint, p_generator bigint,
  p_kind text, p_size integer, p_inject_failure boolean DEFAULT false
) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $page$
DECLARE
  v_cursor bigint;
  v_upper bigint;
  v_last bigint;
  v_count integer := 0;
  v_event record;
BEGIN
  IF p_size < 1 OR p_size > 128 THEN
    RAISE EXCEPTION 'PR359_ISOLATED_UNSAFE_PAGE_SIZE';
  END IF;
  SELECT cursor_id,snapshot_upper_id INTO v_cursor,v_upper
  FROM public.pr359_synthetic_keyset_checkpoint
  WHERE tenant_id=p_tenant AND site_id=p_site AND generator_id=p_generator AND kind=p_kind
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PR359_ISOLATED_SCOPE_HAS_NO_CHECKPOINT';
  END IF;
  v_last := v_cursor;
  FOR v_event IN
    SELECT event_id
    FROM public.pr359_synthetic_keyset_source
    WHERE tenant_id=p_tenant AND site_id=p_site
      AND generator_id=p_generator AND kind=p_kind
      AND event_id > v_cursor AND event_id <= v_upper
    ORDER BY event_id ASC
    LIMIT p_size
  LOOP
    INSERT INTO public.pr359_synthetic_keyset_sink
      (tenant_id,site_id,generator_id,kind,event_id)
    VALUES (p_tenant,p_site,p_generator,p_kind,v_event.event_id)
    ON CONFLICT (tenant_id,site_id,generator_id,kind,event_id) DO NOTHING;
    v_last := v_event.event_id;
    v_count := v_count + 1;
  END LOOP;
  IF p_inject_failure THEN
    RAISE EXCEPTION USING ERRCODE='P3591',
      MESSAGE='PR359_SYNTHETIC_INJECTED_AFTER_WRITES_BEFORE_CHECKPOINT';
  END IF;
  -- In a real system this must be the SAME atomic transaction as durable
  -- downstream acceptance. This stub is NOT the real delta producer.
  UPDATE public.pr359_synthetic_keyset_checkpoint
    SET cursor_id=v_last
  WHERE tenant_id=p_tenant AND site_id=p_site
    AND generator_id=p_generator AND kind=p_kind;
  RETURN v_count;
END
$page$;

-- Synthetic sources: 130 fuel + 70 maintenance for one tenant/site/generator,
-- plus other generators, other sites and other tenants sharing local IDs.
INSERT INTO public.pr359_synthetic_keyset_source
SELECT 1,10,1,'fuel_events',id FROM generate_series(1,130) AS id;
INSERT INTO public.pr359_synthetic_keyset_source
SELECT 1,10,1,'maintenance_work_orders',id FROM generate_series(1,70) AS id;
INSERT INTO public.pr359_synthetic_keyset_source
SELECT 1,10,2,'fuel_events',id FROM generate_series(1,30) AS id;
INSERT INTO public.pr359_synthetic_keyset_source
SELECT 1,11,1,'fuel_events',id FROM generate_series(1,20) AS id;
INSERT INTO public.pr359_synthetic_keyset_source
SELECT 2,10,1,'fuel_events',id FROM generate_series(1,40) AS id;

-- Snapshot high-water marks are captured once for the target scope.
INSERT INTO public.pr359_synthetic_keyset_checkpoint
  (tenant_id,site_id,generator_id,kind,cursor_id,snapshot_upper_id)
SELECT tenant_id,site_id,generator_id,kind,0,max(event_id)
FROM public.pr359_synthetic_keyset_source
WHERE tenant_id=1 AND site_id=10 AND generator_id=1
GROUP BY tenant_id,site_id,generator_id,kind;
DO $assert$
BEGIN
  IF (SELECT count(*) FROM public.pr359_synthetic_keyset_checkpoint)<>2
  OR (SELECT snapshot_upper_id FROM public.pr359_synthetic_keyset_checkpoint
      WHERE kind='fuel_events')<>130
  OR (SELECT snapshot_upper_id FROM public.pr359_synthetic_keyset_checkpoint
      WHERE kind='maintenance_work_orders')<>70
  THEN RAISE EXCEPTION 'PR359_SYNTHETIC_CHECKPOINT_SETUP_FAILED'; END IF;
END
$assert$;
SELECT 'PR359_ISOLATED_KEYSET_CHECKPOINT_SETUP_PASS';
