-- PowerHub Batch B: commit-ordered, tenant/site/entity-scoped delta change feed.
-- This migration adds a server-only change journal for the operational entities
-- already eligible for offline query caching. It does not make sensitive or
-- financial records locally authoritative and does not change existing rows.

create table if not exists public.powerhub_sync_scope_state (
  tenant_id bigint not null,
  site_id bigint not null,
  entity_type text not null check (entity_type in ('sites', 'subscribers', 'generators', 'readings', 'tariffs')),
  last_cursor bigint not null default 0 check (last_cursor >= 0),
  retained_from_cursor bigint not null default 0 check (retained_from_cursor >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, site_id, entity_type),
  check (retained_from_cursor <= last_cursor)
);

create table if not exists public.powerhub_sync_changes (
  tenant_id bigint not null,
  site_id bigint not null,
  entity_type text not null check (entity_type in ('sites', 'subscribers', 'generators', 'readings', 'tariffs')),
  cursor bigint not null check (cursor > 0),
  entity_id text not null check (length(entity_id) between 1 and 100),
  change_type text not null check (change_type in ('upsert', 'delete')),
  row_data jsonb,
  changed_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, site_id, entity_type, cursor),
  check ((change_type = 'upsert' and row_data is not null) or (change_type = 'delete' and row_data is null))
);

create index if not exists powerhub_sync_changes_entity_idx
  on public.powerhub_sync_changes (tenant_id, site_id, entity_type, entity_id, cursor desc);

alter table public.powerhub_sync_scope_state enable row level security;
alter table public.powerhub_sync_changes enable row level security;
revoke all on table public.powerhub_sync_scope_state from public, anon, authenticated;
revoke all on table public.powerhub_sync_changes from public, anon, authenticated;
grant select, insert, update, delete on table public.powerhub_sync_scope_state to service_role;
grant select, insert, update, delete on table public.powerhub_sync_changes to service_role;

-- Per-scope cursor rows are write-locked until the source mutation commits. This
-- gives cursors commit order within (tenant, site, entity), unlike a bare identity
-- sequence where a later transaction could commit first and cause a skipped delta.
create or replace function public.powerhub_append_sync_change(
  p_tenant_id bigint,
  p_site_id bigint,
  p_entity_type text,
  p_entity_id text,
  p_change_type text,
  p_row_data jsonb
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_cursor bigint;
  v_cutoff bigint;
begin
  if p_tenant_id is null or p_tenant_id < 1
     or p_site_id is null or p_site_id < 1
     or p_entity_type not in ('sites', 'subscribers', 'generators', 'readings', 'tariffs')
     or p_entity_id is null or length(p_entity_id) < 1 or length(p_entity_id) > 100
     or p_change_type not in ('upsert', 'delete')
     or (p_change_type = 'upsert' and p_row_data is null)
     or (p_change_type = 'delete' and p_row_data is not null) then
    raise exception 'POWERHUB_SYNC_CHANGE_INVALID' using errcode = 'P0001';
  end if;

  insert into public.powerhub_sync_scope_state (
    tenant_id, site_id, entity_type, last_cursor, retained_from_cursor, updated_at
  ) values (
    p_tenant_id, p_site_id, p_entity_type, 1, 0, clock_timestamp()
  )
  on conflict (tenant_id, site_id, entity_type)
  do update set
    last_cursor = public.powerhub_sync_scope_state.last_cursor + 1,
    updated_at = clock_timestamp()
  returning last_cursor into v_cursor;

  insert into public.powerhub_sync_changes (
    tenant_id, site_id, entity_type, cursor, entity_id, change_type, row_data, changed_at
  ) values (
    p_tenant_id, p_site_id, p_entity_type, v_cursor, p_entity_id,
    p_change_type, p_row_data, clock_timestamp()
  );

  -- Keep the most recent 10,000 change positions per scope. The retained cursor
  -- is the last discarded position; a client older than it must rebuild a snapshot.
  if v_cursor > 10000 and mod(v_cursor, 500) = 0 then
    v_cutoff := v_cursor - 10000;
    delete from public.powerhub_sync_changes c
    where c.tenant_id = p_tenant_id
      and c.site_id = p_site_id
      and c.entity_type = p_entity_type
      and c.cursor <= v_cutoff;

    update public.powerhub_sync_scope_state s
    set retained_from_cursor = greatest(s.retained_from_cursor, v_cutoff),
        updated_at = clock_timestamp()
    where s.tenant_id = p_tenant_id
      and s.site_id = p_site_id
      and s.entity_type = p_entity_type;
  end if;

  return v_cursor;
end;
$$;
alter function public.powerhub_append_sync_change(bigint, bigint, text, text, text, jsonb) owner to postgres;
revoke all on function public.powerhub_append_sync_change(bigint, bigint, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.powerhub_append_sync_change(bigint, bigint, text, text, text, jsonb) to service_role;

-- One trigger contract records inserts/updates and physical deletes. Subscriber
-- archival is exposed as a tombstone, while historical rows remain untouched.
-- meter_readings has no site_id column; its scope is derived from its subscriber.
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
        perform public.powerhub_append_sync_change(v_new_tenant, v_new_site, v_entity_type, v_new ->> 'id', 'upsert', v_new);
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
      perform public.powerhub_append_sync_change(v_new_tenant, v_new_site, v_entity_type, v_new ->> 'id', 'upsert', v_new);
    end if;
  end if;

  -- Meter readings inherit branch scope from their subscriber. If that subscriber
  -- moves between branches in the same tenant, move the cached reading projections too.
  if TG_TABLE_NAME = 'subscribers'
     and v_old_tenant = v_new_tenant
     and v_old_site is not null and v_new_site is not null
     and v_old_site is distinct from v_new_site then
    for v_reading in
      select to_jsonb(r) as row_data
      from public.meter_readings r
      where r.tenant_id = v_new_tenant
        and r.subscriber_id = (v_new ->> 'id')::bigint
    loop
      perform public.powerhub_append_sync_change(v_old_tenant, v_old_site, 'readings', v_reading.row_data ->> 'id', 'delete', null);
      perform public.powerhub_append_sync_change(v_new_tenant, v_new_site, 'readings', v_reading.row_data ->> 'id', 'upsert', v_reading.row_data);
    end loop;
  end if;

  return NEW;
end;
$$;
alter function public.powerhub_capture_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_delta_sync_change() from public, anon, authenticated;
grant execute on function public.powerhub_capture_delta_sync_change() to service_role;

drop trigger if exists powerhub_delta_sync_changes on public.sites;
create trigger powerhub_delta_sync_changes
after insert or update or delete on public.sites
for each row execute function public.powerhub_capture_delta_sync_change();

drop trigger if exists powerhub_delta_sync_changes on public.subscribers;
create trigger powerhub_delta_sync_changes
after insert or update or delete on public.subscribers
for each row execute function public.powerhub_capture_delta_sync_change();

drop trigger if exists powerhub_delta_sync_changes on public.generators;
create trigger powerhub_delta_sync_changes
after insert or update or delete on public.generators
for each row execute function public.powerhub_capture_delta_sync_change();

drop trigger if exists powerhub_delta_sync_changes on public.meter_readings;
create trigger powerhub_delta_sync_changes
after insert or update or delete on public.meter_readings
for each row execute function public.powerhub_capture_delta_sync_change();

drop trigger if exists powerhub_delta_sync_changes on public.tariffs;
create trigger powerhub_delta_sync_changes
after insert or update or delete on public.tariffs
for each row execute function public.powerhub_capture_delta_sync_change();

create or replace function public.powerhub_pull_sync_delta(
  p_tenant_id bigint,
  p_site_id bigint,
  p_entity_type text,
  p_after_cursor bigint,
  p_through_cursor bigint default null,
  p_page_size integer default 200
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_current_cursor bigint := 0;
  v_retained_from bigint := 0;
  v_target_cursor bigint := 0;
  v_next_cursor bigint := 0;
  v_last_page_cursor bigint;
  v_has_more boolean := false;
  v_changes jsonb := '[]'::jsonb;
  v_row_count integer := 0;
begin
  if p_tenant_id is null or p_tenant_id < 1 or p_site_id is null or p_site_id < 1 then
    raise exception 'POWERHUB_SYNC_SCOPE_REQUIRED' using errcode = 'P0001';
  end if;
  if p_entity_type not in ('sites', 'subscribers', 'generators', 'readings', 'tariffs') then
    raise exception 'POWERHUB_SYNC_ENTITY_UNSUPPORTED' using errcode = 'P0001';
  end if;
  if p_page_size is null or p_page_size < 1 or p_page_size > 500 then
    raise exception 'POWERHUB_SYNC_PAGE_SIZE_INVALID' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id
  ) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  select s.last_cursor, s.retained_from_cursor
    into v_current_cursor, v_retained_from
  from public.powerhub_sync_scope_state s
  where s.tenant_id = p_tenant_id and s.site_id = p_site_id and s.entity_type = p_entity_type;
  if not found then
    v_current_cursor := 0;
    v_retained_from := 0;
  end if;

  -- A missing cursor means the caller has no trusted snapshot. It must fetch the
  -- entity snapshot, then resume from this checkpoint to catch changes during load.
  if p_after_cursor is null or p_after_cursor < v_retained_from then
    return jsonb_build_object(
      'status', 'reset_required',
      'entity_type', p_entity_type,
      'current_cursor', v_current_cursor::text,
      'retained_from_cursor', v_retained_from::text,
      'snapshot_cursor', v_current_cursor::text,
      'through_cursor', v_current_cursor::text,
      'next_cursor', null,
      'has_more', false,
      'changes', '[]'::jsonb
    );
  end if;

  if p_after_cursor < 0 or p_after_cursor > v_current_cursor then
    raise exception 'POWERHUB_SYNC_CURSOR_INVALID' using errcode = 'P0001';
  end if;

  if p_through_cursor is null then
    v_target_cursor := v_current_cursor;
  else
    v_target_cursor := p_through_cursor;
    if v_target_cursor < p_after_cursor or v_target_cursor > v_current_cursor then
      raise exception 'POWERHUB_SYNC_TARGET_CURSOR_INVALID' using errcode = 'P0001';
    end if;
  end if;

  with page_rows as (
    select c.cursor, c.entity_type, c.entity_id, c.change_type, c.row_data, c.changed_at
    from public.powerhub_sync_changes c
    where c.tenant_id = p_tenant_id
      and c.site_id = p_site_id
      and c.entity_type = p_entity_type
      and c.cursor > p_after_cursor
      and c.cursor <= v_target_cursor
    order by c.cursor
    limit p_page_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'cursor', p.cursor::text,
           'entity_type', p.entity_type,
           'entity_id', p.entity_id,
           'operation', p.change_type,
           'row_data', p.row_data,
           'changed_at', p.changed_at
         ) order by p.cursor), '[]'::jsonb),
         max(p.cursor),
         count(*)::integer
    into v_changes, v_last_page_cursor, v_row_count
  from page_rows p;

  select exists (
    select 1 from public.powerhub_sync_changes c
    where c.tenant_id = p_tenant_id
      and c.site_id = p_site_id
      and c.entity_type = p_entity_type
      and c.cursor > coalesce(v_last_page_cursor, p_after_cursor)
      and c.cursor <= v_target_cursor
  ) into v_has_more;

  if v_has_more then
    v_next_cursor := coalesce(v_last_page_cursor, p_after_cursor);
  else
    v_next_cursor := v_target_cursor;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'entity_type', p_entity_type,
    'current_cursor', v_current_cursor::text,
    'retained_from_cursor', v_retained_from::text,
    'snapshot_cursor', null,
    'through_cursor', v_target_cursor::text,
    'next_cursor', v_next_cursor::text,
    'has_more', v_has_more,
    'changes', v_changes
  );
end;
$$;
alter function public.powerhub_pull_sync_delta(bigint, bigint, text, bigint, bigint, integer) owner to postgres;
revoke all on function public.powerhub_pull_sync_delta(bigint, bigint, text, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function public.powerhub_pull_sync_delta(bigint, bigint, text, bigint, bigint, integer) to service_role;

-- Do not make the private writer API part of the browser's callable surface.
revoke all on function public.powerhub_append_sync_change(bigint, bigint, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.powerhub_capture_delta_sync_change() from public, anon, authenticated;
revoke all on function public.powerhub_pull_sync_delta(bigint, bigint, text, bigint, bigint, integer) from public, anon, authenticated;
