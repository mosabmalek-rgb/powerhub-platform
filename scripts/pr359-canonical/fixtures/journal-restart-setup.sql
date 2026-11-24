-- PR359 CB-A: synthetic mutation journal, NOT actual Delta producer or migration.
-- Disposable PostgreSQL container only; no Staging/Production writes.
\set ON_ERROR_STOP on
CREATE TABLE public.pr359_synthetic_change_journal (
  change_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL, site_id bigint NOT NULL,
  generator_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fuel_events','maintenance_work_orders')),
  event_id bigint NOT NULL CHECK (event_id > 0),
  change_kind text NOT NULL CHECK (change_kind IN ('upsert','delete')),
  revision integer NOT NULL CHECK (revision > 0)
);
CREATE TABLE public.pr359_synthetic_change_checkpoint (
  tenant_id bigint NOT NULL, site_id bigint NOT NULL,
  generator_id bigint NOT NULL, kind text NOT NULL,
  cursor_seq bigint NOT NULL DEFAULT 0,
  snapshot_upper_seq bigint NOT NULL,
  PRIMARY KEY (tenant_id,site_id,generator_id,kind),
  CHECK (cursor_seq <= snapshot_upper_seq)
);
CREATE TABLE public.pr359_synthetic_change_sink (
  tenant_id bigint NOT NULL, site_id bigint NOT NULL,
  generator_id bigint NOT NULL, kind text NOT NULL,
  event_id bigint NOT NULL, change_seq bigint NOT NULL,
  change_kind text NOT NULL, revision integer NOT NULL,
  PRIMARY KEY (tenant_id,site_id,generator_id,kind,event_id)
);

CREATE FUNCTION public.pr359_synthetic_apply_change_page(
  p_tenant bigint, p_site bigint, p_generator bigint,
  p_kind text, p_size integer, p_inject_failure boolean DEFAULT false
) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp
AS $page$
DECLARE
  v_cursor bigint; v_upper bigint; v_last bigint;
  v_count integer:=0; v_change record;
BEGIN
  IF p_size < 1 OR p_size > 128 THEN
    RAISE EXCEPTION 'PR359_CHANGE_PAGE_SIZE_INVALID';
  END IF;
  SELECT cursor_seq,snapshot_upper_seq INTO v_cursor,v_upper
    FROM public.pr359_synthetic_change_checkpoint
   WHERE tenant_id=p_tenant AND site_id=p_site
     AND generator_id=p_generator AND kind=p_kind
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PR359_CHANGE_SCOPE_CHECKPOINT_MISSING';
  END IF;
  v_last:=v_cursor;
  FOR v_change IN
    SELECT change_seq,event_id,change_kind,revision
      FROM public.pr359_synthetic_change_journal
     WHERE tenant_id=p_tenant AND site_id=p_site
       AND generator_id=p_generator AND kind=p_kind
       AND change_seq>v_cursor AND change_seq<=v_upper
     ORDER BY change_seq LIMIT p_size
  LOOP
    INSERT INTO public.pr359_synthetic_change_sink
       (tenant_id,site_id,generator_id,kind,event_id,
        change_seq,change_kind,revision)
    VALUES (p_tenant,p_site,p_generator,p_kind,v_change.event_id,
            v_change.change_seq,v_change.change_kind,v_change.revision)
    ON CONFLICT (tenant_id,site_id,generator_id,kind,event_id)
    DO UPDATE SET
      change_seq=EXCLUDED.change_seq,
      change_kind=EXCLUDED.change_kind,
      revision=EXCLUDED.revision
    WHERE public.pr359_synthetic_change_sink.change_seq<EXCLUDED.change_seq;
    v_last:=v_change.change_seq;
    v_count:=v_count+1;
  END LOOP;
  IF p_inject_failure THEN
    RAISE EXCEPTION USING ERRCODE='P3592',
      MESSAGE='PR359_SYNTHETIC_CHANGE_FAILURE_BEFORE_CURSOR_COMMIT';
  END IF;
  UPDATE public.pr359_synthetic_change_checkpoint
     SET cursor_seq=v_last
   WHERE tenant_id=p_tenant AND site_id=p_site
     AND generator_id=p_generator AND kind=p_kind;
  RETURN v_count;
END
$page$;

INSERT INTO public.pr359_synthetic_change_journal
 (tenant_id,site_id,generator_id,kind,event_id,change_kind,revision) VALUES
 (1,10,1,'fuel_events',201,'upsert',1),
 (1,10,1,'fuel_events',201,'delete',2),
 (1,10,1,'fuel_events',202,'upsert',1),
 (2,10,1,'fuel_events',201,'upsert',1),
 (1,10,1,'fuel_events',202,'upsert',2),
 (1,10,2,'fuel_events',202,'upsert',1),
 (1,11,1,'fuel_events',202,'upsert',1),
 (1,10,1,'maintenance_work_orders',900,'upsert',1);
INSERT INTO public.pr359_synthetic_change_checkpoint
 (tenant_id,site_id,generator_id,kind,cursor_seq,snapshot_upper_seq)
SELECT 1,10,1,'fuel_events',0,max(change_seq)
 FROM public.pr359_synthetic_change_journal
 WHERE tenant_id=1 AND site_id=10 AND generator_id=1 AND kind='fuel_events';
DO $check$
BEGIN
 IF (SELECT snapshot_upper_seq FROM public.pr359_synthetic_change_checkpoint)<>5
 OR (SELECT count(*) FROM public.pr359_synthetic_change_journal)<>8
 THEN RAISE EXCEPTION 'PR359_CHANGE_SETUP_INVALID'; END IF;
END
$check$;
SELECT 'PR359_ISOLATED_CHANGE_JOURNAL_SETUP_PASS';
