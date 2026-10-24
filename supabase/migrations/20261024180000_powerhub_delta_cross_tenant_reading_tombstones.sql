-- PowerHub Batch B follow-up: tombstone reading cache on cross-tenant subscriber moves.
create index if not exists powerhub_offline_number_grants_site_fk_idx on public.powerhub_offline_number_grants(site_id);
create index if not exists powerhub_offline_number_claims_site_fk_idx on public.powerhub_offline_number_claims(site_id);

create or replace function public.powerhub_capture_delta_sync_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_old_tenant bigint;
  v_old_site bigint;
  v_new_tenant bigint;
  v_new_site bigint;
  v_entity_type text;
  v_entity_id text;
  v_change_type text;
  v_projected_new jsonb;
  v_tenant_name text;
  v_reading record;
begin
  v_entity_type := case TG_TABLE_NAME
    when 'sites' then 'sites'
    when 'subscribers' then 'subscribers'
    when 'generators' then 'generators'
    when 'meter_readings' then 'readings'
    when 'tariffs' then 'tariffs'
    else null
  end;
  if v_entity_type is null then
    raise exception 'POWERHUB_SYNC_TABLE_UNSUPPORTED' using errcode = 'P0001';
  end if;

  if TG_OP <> 'INSERT' then v_old := to_jsonb(OLD); end if;
  if TG_OP <> 'DELETE' then v_new := to_jsonb(NEW); end if;

  if TG_TABLE_NAME = 'sites' and v_old is not null then
    select t.name into v_tenant_name
    from public.tenants t where t.id = nullif(v_old ->> 'tenant_id', '')::bigint;
    if v_tenant_name is not null then
      v_old := v_old || jsonb_build_object('tenant_name', v_tenant_name);
    end if;
  end if;
  if TG_TABLE_NAME = 'sites' and v_new is not null then
    select t.name into v_tenant_name
    from public.tenants t where t.id = nullif(v_new ->> 'tenant_id', '')::bigint;
    if v_tenant_name is not null then
      v_new := v_new || jsonb_build_object('tenant_name', v_tenant_name);
    end if;
  end if;

  if v_old is not null then
    v_old_tenant := nullif(v_old ->> 'tenant_id', '')::bigint;
    if TG_TABLE_NAME = 'sites' then
      v_old_site := nullif(v_old ->> 'id', '')::bigint;
    elsif TG_TABLE_NAME = 'meter_readings' then
      select s.site_id into v_old_site
      from public.subscribers s
      where s.id = nullif(v_old ->> 'subscriber_id', '')::bigint
        and s.tenant_id = v_old_tenant;
    else
      v_old_site := nullif(v_old ->> 'site_id', '')::bigint;
    end if;
  end if;

  if v_new is not null then
    v_new_tenant := nullif(v_new ->> 'tenant_id', '')::bigint;
    if TG_TABLE_NAME = 'sites' then
      v_new_site := nullif(v_new ->> 'id', '')::bigint;
    elsif TG_TABLE_NAME = 'meter_readings' then
      select s.site_id into v_new_site
      from public.subscribers s
      where s.id = nullif(v_new ->> 'subscriber_id', '')::bigint
        and s.tenant_id = v_new_tenant;
    else
      v_new_site := nullif(v_new ->> 'site_id', '')::bigint;
    end if;
  end if;

  if TG_OP = 'INSERT' then
    if v_new_tenant is not null and v_new_site is not null then
      if coalesce(v_new ->> 'archived_at', '') <> '' then
        perform public.powerhub_append_sync_change(v_new_tenant, v_new_site, v_entity_type, v_new ->> 'id', 'delete', null);
      else
        v_projected_new := public.powerhub_delta_sync_project_row(v_entity_type, v_new);
        perform public.powerhub_append_sync_change(v_new_tenant, v_new_site, v_entity_type, v_new ->> 'id', 'upsert', v_projected_new);
      end if;
    end if;
    return NEW;
  elsif TG_OP = 'DELETE' then
    if v_old_tenant is not null and v_old_site is not null then
      perform public.powerhub_append_sync_change(v_old_tenant, v_old_site, v_entity_type, v_old ->> 'id', 'delete', null);
    end if;
    return OLD;
  end if;

  if v_old is not distinct from v_new then
    return NEW;
  end if;

  -- A scope move removes the old copy before publishing the new scoped row.
  if v_old_tenant is not null and v_old_site is not null
     and (v_old_tenant is distinct from v_new_tenant or v_old_site is distinct from v_new_site) then
    perform public.powerhub_append_sync_change(v_old_tenant, v_old_site, v_entity_type, v_old ->> 'id', 'delete', null);
  elsif v_old_tenant is not null and v_old_site is not null
        and TG_TABLE_NAME = 'subscribers'
        and coalesce(v_old ->> 'archived_at', '') = ''
        and coalesce(v_new ->> 'archived_at', '') <> '' then
    perform public.powerhub_append_sync_change(v_old_tenant, v_old_site, v_entity_type, v_old ->> 'id', 'delete', null);
  end if;

  if v_new_tenant is not null and v_new_site is not null then
    if coalesce(v_new ->> 'archived_at', '') <> '' then
      if v_old_tenant is null or v_old_site is null
         or (v_old_tenant is distinct from v_new_tenant or v_old_site is distinct from v_new_site) then
        perform public.powerhub_append_sync_change(v_new_tenant, v_new_site, v_entity_type, v_new ->> 'id', 'delete', null);
      end if;
    else
      v_projected_new := public.powerhub_delta_sync_project_row(v_entity_type, v_new);
      perform public.powerhub_append_sync_change(v_new_tenant, v_new_site, v_entity_type, v_new ->> 'id', 'upsert', v_projected_new);
    end if;
  end if;

  -- Reading rows inherit scope from the subscriber; always tombstone the old cache
  -- on a tenant/site move. Upsert in the new scope only when the reading row already
  -- belongs to the new tenant; a later reading update will publish it otherwise.
  if TG_TABLE_NAME = 'subscribers'
     and v_old_tenant is not null and v_new_tenant is not null
     and v_old_site is not null and v_new_site is not null
     and (v_old_tenant is distinct from v_new_tenant or v_old_site is distinct from v_new_site) then
    for v_reading in
      select to_jsonb(r) as row_data, r.tenant_id as reading_tenant_id
      from public.meter_readings r
      where r.subscriber_id = (v_new ->> 'id')::bigint
        and r.tenant_id in (v_old_tenant, v_new_tenant)
    loop
      perform public.powerhub_append_sync_change(v_old_tenant, v_old_site, 'readings', v_reading.row_data ->> 'id', 'delete', null);
      if v_reading.reading_tenant_id = v_new_tenant then
        perform public.powerhub_append_sync_change(v_new_tenant, v_new_site, 'readings', v_reading.row_data ->> 'id', 'upsert',
          public.powerhub_delta_sync_project_row('readings', v_reading.row_data));
      end if;
    end loop;
  end if;

  return NEW;
end;
$$;
alter function public.powerhub_capture_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_delta_sync_change() from public, anon, authenticated;
grant execute on function public.powerhub_capture_delta_sync_change() to service_role;
