-- Candidate only: install inside the dedicated networkless concurrency database.
BEGIN;
DO $install$
DECLARE definition text; anchor text:=$anchor$begin
  if p_entity_type='fuel_events' then$anchor$;
replacement text:=$replacement$begin
  -- Serialize projection with the same row that Append uses, without reserving a cursor.
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1
     or p_entity_id is null or p_entity_id<1
     or p_entity_type is null or not (
       p_entity_type in ('fuel_events','maintenance_work_orders')
       or p_entity_type ~ '^maintenance_work_order_parts:[1-9][0-9]{0,15}$'
     )
  then raise exception 'PR359_CANDIDATE_EMIT_SCOPE_INVALID' using errcode='P0001'; end if;

  insert into public.powerhub_sync_scope_state(tenant_id,site_id,entity_type,last_cursor,retained_from_cursor,updated_at)
    values(p_tenant_id,p_site_id,p_entity_type,0,0,clock_timestamp())
    on conflict(tenant_id,site_id,entity_type) do nothing;
  perform 1 from public.powerhub_sync_scope_state s
    where s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.entity_type=p_entity_type
    for update;
  if not found then raise exception 'PR359_CANDIDATE_EMIT_SCOPE_LOCK_MISSING'; end if;

  if p_entity_type='fuel_events' then$replacement$;
BEGIN
 IF current_database()<>'pr359_indirect_concurrency' THEN
  RAISE EXCEPTION 'PR359_DISPOSABLE_DATABASE_REQUIRED';
 END IF;
 SELECT pg_get_functiondef('public.powerhub_emit_fuel_maintenance_delta_sync_change(bigint,bigint,text,bigint)'::regprocedure)
 INTO STRICT definition;
 IF array_length(string_to_array(definition,anchor),1) IS DISTINCT FROM 2
 OR definition NOT LIKE '%SECURITY DEFINER%'
 OR definition NOT LIKE '%powerhub_append_fuel_maintenance_delta_sync_change%'
 OR definition LIKE '%PR359_CANDIDATE_EMIT_SCOPE_LOCK_MISSING%'
 THEN RAISE EXCEPTION 'PR359_EMIT_CANDIDATE_ANCHOR_DRIFT'; END IF;
 EXECUTE replace(definition,anchor,replacement);
END $install$;
-- Preserve the existing cursor allocator, validate a fresh scope starts at one,
-- and prove rollback removes a scope created by the new pre-lock.
DO $atomic$
DECLARE caught boolean:=false; old_states jsonb; old_journal jsonb; v bigint;
BEGIN
 SELECT jsonb_agg(to_jsonb(s) ORDER BY tenant_id,site_id,entity_type) INTO old_states FROM public.powerhub_sync_scope_state s;
 SELECT jsonb_agg(to_jsonb(c) ORDER BY tenant_id,site_id,entity_type,cursor) INTO old_journal FROM public.powerhub_sync_changes c;
 BEGIN
  PERFORM public.powerhub_emit_fuel_maintenance_delta_sync_change(1,101,'maintenance_work_order_parts:299999',299998);
  SELECT last_cursor INTO STRICT v FROM public.powerhub_sync_scope_state WHERE tenant_id=1 AND site_id=101 AND entity_type='maintenance_work_order_parts:299999';
  IF v<>1 OR NOT EXISTS(SELECT 1 FROM public.powerhub_sync_changes WHERE tenant_id=1 AND site_id=101 AND entity_type='maintenance_work_order_parts:299999' AND cursor=1 AND entity_id='299998' AND change_type='delete' AND row_data IS NULL)
  THEN RAISE EXCEPTION 'PR359_EMIT_NEW_SCOPE_CURSOR_FAILED'; END IF;
  RAISE EXCEPTION USING ERRCODE='P3594',MESSAGE='forced rollback';
 EXCEPTION WHEN SQLSTATE 'P3594' THEN caught:=true;
 END;
 IF NOT caught THEN RAISE EXCEPTION 'PR359_EMIT_ROLLBACK_NOT_CAUGHT'; END IF;
 BEGIN
  PERFORM public.powerhub_emit_fuel_maintenance_delta_sync_change(1,101,NULL,299998);
  RAISE EXCEPTION 'invalid emit accepted';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'PR359_CANDIDATE_EMIT_SCOPE_INVALID' THEN RAISE; END IF;
 END;
 IF old_states IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(s) ORDER BY tenant_id,site_id,entity_type) FROM public.powerhub_sync_scope_state s)
 OR old_journal IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(c) ORDER BY tenant_id,site_id,entity_type,cursor) FROM public.powerhub_sync_changes c)
 THEN RAISE EXCEPTION 'PR359_EMIT_SCOPE_ATOMICITY_FAILED'; END IF;
END $atomic$;
COMMIT;
SELECT 'PR359_EMIT_LOCK_BEFORE_PROJECTION_INSTALLED';
SELECT 'PR359_EMIT_NEW_SCOPE_AND_ROLLBACK_PASS';
