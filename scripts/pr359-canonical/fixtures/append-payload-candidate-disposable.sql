-- Test-only candidate, not a migration or production approval.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$
BEGIN
 IF current_database() <> 'pr359_real_append' THEN
  RAISE EXCEPTION 'PR359_DISPOSABLE_DATABASE_REQUIRED';
 END IF;
END $guard$;
CREATE TABLE public.generator_maintenance_work_orders(
 id bigint PRIMARY KEY, tenant_id bigint NOT NULL, site_id bigint NOT NULL
);
INSERT INTO public.generator_maintenance_work_orders VALUES
 (940001,1,101),(940002,1,101),(940003,2,201);
-- Inject a preflight into the already loaded, pinned archived definition.
-- Refuse drift; leave cursor allocation and retention body unchanged.
DO $candidate$
DECLARE ddl text;
 anchor constant text := '  insert into public.powerhub_sync_scope_state';
 preflight constant text := $check$
  if p_entity_type is null or p_change_type is null
     or p_entity_id is null or p_entity_id !~ '^[1-9][0-9]{0,18}$'
  then raise exception 'PR359_CANDIDATE_PAYLOAD_INVALID' using errcode='P0001'; end if;
  if p_entity_id::numeric > 9223372036854775807::numeric
  then raise exception 'PR359_CANDIDATE_PAYLOAD_INVALID' using errcode='P0001'; end if;
  if p_change_type='upsert' then
    if jsonb_typeof(p_row_data) is distinct from 'object'
       or coalesce(jsonb_typeof(p_row_data->'id'),'missing') not in ('number','string')
       or coalesce(jsonb_typeof(p_row_data->'tenant_id'),'missing') not in ('number','string')
       or coalesce(jsonb_typeof(p_row_data->'site_id'),'missing') not in ('number','string')
       or p_row_data->>'tenant_id' is distinct from p_tenant_id::text
       or p_row_data->>'site_id' is distinct from p_site_id::text
    then raise exception 'PR359_CANDIDATE_PAYLOAD_INVALID' using errcode='P0001'; end if;
    if p_entity_type like 'maintenance_work_order_parts:%' then
      if coalesce(jsonb_typeof(p_row_data->'work_order_id'),'missing') not in ('number','string')
         or p_row_data->>'work_order_id' is distinct from split_part(p_entity_type,':',2)
         or not exists(select 1 from public.generator_maintenance_work_orders w
              where w.tenant_id=p_tenant_id and w.site_id=p_site_id
                and w.id::text=split_part(p_entity_type,':',2))
      then raise exception 'PR359_CANDIDATE_PAYLOAD_INVALID' using errcode='P0001'; end if;
    end if;
  end if;

$check$;
BEGIN
 SELECT pg_get_functiondef('public.powerhub_append_fuel_maintenance_delta_sync_change(bigint,bigint,text,text,text,jsonb)'::regprocedure) INTO ddl;
 IF length(ddl)-length(replace(ddl,anchor,'')) <> length(anchor)
 OR position('PR359_CANDIDATE_PAYLOAD_INVALID' in ddl)>0 THEN
  RAISE EXCEPTION 'PR359_CANDIDATE_ARCHIVE_ANCHOR_DRIFT';
 END IF;
 EXECUTE replace(ddl,anchor,preflight||anchor);
END $candidate$;
-- Synthetic ACL: do not interpret these roles as actual hosted role evidence.
CREATE ROLE pr359_candidate_denied NOLOGIN;
CREATE ROLE pr359_candidate_writer NOLOGIN;
REVOKE ALL ON FUNCTION public.powerhub_append_fuel_maintenance_delta_sync_change(bigint,bigint,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.powerhub_append_fuel_maintenance_delta_sync_change(bigint,bigint,text,text,text,jsonb) TO pr359_candidate_writer;
DO $acl$
BEGIN
 IF has_function_privilege('pr359_candidate_denied','public.powerhub_append_fuel_maintenance_delta_sync_change(bigint,bigint,text,text,text,jsonb)','EXECUTE')
 OR NOT has_function_privilege('pr359_candidate_writer','public.powerhub_append_fuel_maintenance_delta_sync_change(bigint,bigint,text,text,text,jsonb)','EXECUTE')
 THEN RAISE EXCEPTION 'PR359_CANDIDATE_SYNTHETIC_ACL_FAILED'; END IF;
END $acl$;
SET LOCAL ROLE pr359_candidate_denied;
DO $denied$
DECLARE rejected boolean:=false;
BEGIN
 BEGIN
  PERFORM public.powerhub_append_fuel_maintenance_delta_sync_change(1,101,'fuel_events','940004','upsert','{"id":940004,"tenant_id":1,"site_id":101}'::jsonb);
 EXCEPTION WHEN insufficient_privilege THEN rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'PR359_CANDIDATE_UNAUTHORIZED_EXECUTE'; END IF;
END $denied$;
RESET ROLE;
DO $verify$
DECLARE
 rec record;
 rejected boolean;
 before_state jsonb;
 before_journal bigint;
 after_state jsonb;
 valid_payload jsonb:='{"id":940004,"tenant_id":1,"site_id":101}'::jsonb;
 part_payload jsonb:='{"id":940005,"tenant_id":1,"site_id":101,"work_order_id":940001}'::jsonb;
 current_id bigint;
 page jsonb;
BEGIN
 SELECT jsonb_agg(to_jsonb(s) ORDER BY tenant_id,site_id,entity_type) INTO before_state
 FROM public.powerhub_sync_scope_state s;
 SELECT count(*) INTO before_journal FROM public.powerhub_sync_changes;
 FOR rec IN SELECT * FROM (VALUES
  ('foreign tenant','fuel_events','940004','upsert','{"id":940004,"tenant_id":2,"site_id":101}'::jsonb),
  ('foreign site','fuel_events','940004','upsert','{"id":940004,"tenant_id":1,"site_id":201}'::jsonb),
  ('missing tenant','fuel_events','940004','upsert','{"id":940004,"site_id":101}'::jsonb),
  ('missing site','fuel_events','940004','upsert','{"id":940004,"tenant_id":1}'::jsonb),
  ('null tenant','fuel_events','940004','upsert','{"id":940004,"tenant_id":null,"site_id":101}'::jsonb),
  ('wrong parent','maintenance_work_order_parts:940001','940005','upsert','{"id":940005,"tenant_id":1,"site_id":101,"work_order_id":940002}'::jsonb),
  ('foreign parent','maintenance_work_order_parts:940003','940005','upsert','{"id":940005,"tenant_id":1,"site_id":101,"work_order_id":940003}'::jsonb),
  ('missing parent','maintenance_work_order_parts:940001','940005','upsert','{"id":940005,"tenant_id":1,"site_id":101}'::jsonb),
  ('unknown parent','maintenance_work_order_parts:940099','940005','upsert','{"id":940005,"tenant_id":1,"site_id":101,"work_order_id":940099}'::jsonb),
  ('malformed id','fuel_events','bad','upsert','{"id":"bad","tenant_id":1,"site_id":101}'::jsonb),
  ('overflow id','fuel_events','9223372036854775808','upsert','{"id":"9223372036854775808","tenant_id":1,"site_id":101}'::jsonb),
  ('invalid operation','fuel_events','940004','bogus',valid_payload),
  ('null operation','fuel_events','940004',NULL,valid_payload),
  ('null entity',NULL,'940004','delete',NULL),
  ('invalid tombstone','fuel_events','940004','delete',valid_payload),
  ('array payload','fuel_events','940004','upsert','[]'::jsonb),
  ('mismatched id','fuel_events','940004','upsert','{"id":940006,"tenant_id":1,"site_id":101}'::jsonb)
 ) AS t(label,entity,entity_id,op,payload)
 LOOP
  rejected:=false;
  BEGIN
   PERFORM public.powerhub_append_fuel_maintenance_delta_sync_change(1,101,rec.entity,rec.entity_id,rec.op,rec.payload);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
   IF SQLERRM IN ('PR359_CANDIDATE_PAYLOAD_INVALID','POWERHUB_FUEL_MAINTENANCE_DELTA_INVALID')
   THEN rejected:=true; ELSE RAISE; END IF;
  END;
  SELECT jsonb_agg(to_jsonb(s) ORDER BY tenant_id,site_id,entity_type) INTO after_state
  FROM public.powerhub_sync_scope_state s;
  IF NOT rejected OR after_state IS DISTINCT FROM before_state
   OR (SELECT count(*) FROM public.powerhub_sync_changes) IS DISTINCT FROM before_journal
  THEN RAISE EXCEPTION 'PR359_CANDIDATE_REJECTION_OR_ATOMICITY_FAILED: %',rec.label; END IF;
 END LOOP;
 current_id:=public.powerhub_append_fuel_maintenance_delta_sync_change(1,101,'fuel_events','940004','upsert',valid_payload);
 IF current_id IS DISTINCT FROM 4 THEN RAISE EXCEPTION 'PR359_CANDIDATE_VALID_UPSERT_FAILED'; END IF;
 page:=public.powerhub_pull_fuel_maintenance_sync_delta(1,101,'fuel_events',3,4,200);
 IF page->>'status' IS DISTINCT FROM 'ok' OR page->'changes'->0->'row_data' IS DISTINCT FROM valid_payload
 THEN RAISE EXCEPTION 'PR359_CANDIDATE_PULL_FAILED'; END IF;
 current_id:=public.powerhub_append_fuel_maintenance_delta_sync_change(1,101,'maintenance_work_order_parts:940001','940005','upsert',part_payload);
 IF current_id IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'PR359_CANDIDATE_PART_UPSERT_FAILED'; END IF;
 DELETE FROM public.generator_maintenance_work_orders WHERE id=940001;
 current_id:=public.powerhub_append_fuel_maintenance_delta_sync_change(1,101,'maintenance_work_order_parts:940001','940005','delete',NULL);
 IF current_id IS DISTINCT FROM 2 OR NOT EXISTS(SELECT 1 FROM public.powerhub_sync_changes
   WHERE tenant_id=1 AND site_id=101 AND entity_type='maintenance_work_order_parts:940001'
    AND cursor=2 AND change_type='delete' AND row_data IS NULL)
 THEN RAISE EXCEPTION 'PR359_CANDIDATE_DELETED_PARENT_TOMBSTONE_FAILED'; END IF;
 -- A synthetic source transaction must roll back with its journal append.
 rejected:=false;
 BEGIN
  PERFORM public.powerhub_append_fuel_maintenance_delta_sync_change(1,101,'fuel_events','940004','delete',NULL);
  RAISE EXCEPTION USING ERRCODE='P3595',MESSAGE='PR359_CANDIDATE_ROLLBACK_INJECTION';
 EXCEPTION WHEN SQLSTATE 'P3595' THEN rejected:=true;
 END;
 IF NOT rejected OR EXISTS(SELECT 1 FROM public.powerhub_sync_changes WHERE tenant_id=1 AND site_id=101 AND entity_type='fuel_events' AND cursor>4)
 OR (SELECT last_cursor FROM public.powerhub_sync_scope_state WHERE tenant_id=1 AND site_id=101 AND entity_type='fuel_events') IS DISTINCT FROM 4
 THEN RAISE EXCEPTION 'PR359_CANDIDATE_ROLLBACK_FAILED'; END IF;
END $verify$;
-- Verify candidate retains the same retention semantics at next 500-event boundary.
DO $retention$
DECLARE n bigint; result_cursor bigint; page jsonb;
BEGIN
 FOR n IN 10501..11000 LOOP
  result_cursor:=public.powerhub_append_fuel_maintenance_delta_sync_change(
   1,102,'fuel_events',n::text,'upsert',jsonb_build_object('id',n,'tenant_id',1,'site_id',102));
  IF result_cursor IS DISTINCT FROM n THEN RAISE EXCEPTION 'PR359_CANDIDATE_CURSOR_SEQUENCE_FAILED'; END IF;
 END LOOP;
 IF (SELECT retained_from_cursor FROM public.powerhub_sync_scope_state WHERE tenant_id=1 AND site_id=102 AND entity_type='fuel_events') IS DISTINCT FROM 1000
 OR (SELECT count(*) FROM public.powerhub_sync_changes WHERE tenant_id=1 AND site_id=102 AND entity_type='fuel_events') IS DISTINCT FROM 10000
 THEN RAISE EXCEPTION 'PR359_CANDIDATE_RETENTION_FAILED'; END IF;
 page:=public.powerhub_pull_fuel_maintenance_sync_delta(1,102,'fuel_events',999,NULL,200);
 IF page->>'status' IS DISTINCT FROM 'reset_required' OR page->>'snapshot_cursor' IS DISTINCT FROM '11000'
 THEN RAISE EXCEPTION 'PR359_CANDIDATE_RESET_FAILED'; END IF;
END $retention$;
ROLLBACK;
DO $restore$
BEGIN
 IF position('PR359_CANDIDATE_PAYLOAD_INVALID' in pg_get_functiondef('public.powerhub_append_fuel_maintenance_delta_sync_change(bigint,bigint,text,text,text,jsonb)'::regprocedure))>0
 OR to_regclass('public.generator_maintenance_work_orders') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('pr359_candidate_denied','pr359_candidate_writer'))
 OR (SELECT last_cursor FROM public.powerhub_sync_scope_state WHERE tenant_id=1 AND site_id=101 AND entity_type='fuel_events') IS DISTINCT FROM 3
 OR (SELECT last_cursor FROM public.powerhub_sync_scope_state WHERE tenant_id=1 AND site_id=102 AND entity_type='fuel_events') IS DISTINCT FROM 10500
 THEN RAISE EXCEPTION 'PR359_CANDIDATE_FIXTURE_RESTORE_FAILED'; END IF;
END $restore$;
SELECT 'PR359_CANDIDATE_PAYLOAD_17_NEGATIVE_CASES_PASS';
SELECT 'PR359_CANDIDATE_SYNTHETIC_ACL_PASS';
SELECT 'PR359_CANDIDATE_VALID_UPSERT_TOMBSTONE_ROLLBACK_PASS';
SELECT 'PR359_CANDIDATE_RETENTION_RESET_PASS';
SELECT 'PR359_CANDIDATE_FIXTURE_RESTORE_PASS';
SELECT 'PR359_CANONICAL_BASELINE_APPROVED=FALSE';
