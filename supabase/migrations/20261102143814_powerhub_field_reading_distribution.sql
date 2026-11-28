-- Optional address-based assignment of subscribers to field readers.
-- When disabled or not configured, assigned_reader_user_id stays NULL and
-- every authorized reader continues to see all active subscribers.
alter table public.subscribers
  add column if not exists assigned_reader_user_id bigint
  references public.users(id) on delete set null;

create index if not exists subscribers_field_reader_scope_idx
  on public.subscribers (tenant_id, site_id, assigned_reader_user_id, id)
  where assigned_reader_user_id is not null;

create table if not exists public.field_reading_distribution_settings (
  tenant_id bigint not null references public.tenants(id) on delete cascade,
  site_id bigint not null references public.sites(id) on delete cascade,
  is_enabled boolean not null default false,
  reader_user_ids bigint[] not null default '{}'::bigint[],
  updated_by_user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, site_id),
  constraint field_reading_distribution_site_tenant_fk
    foreign key (site_id, tenant_id) references public.sites(id, tenant_id)
    on delete cascade
);

alter table public.field_reading_distribution_settings enable row level security;
alter table public.field_reading_distribution_settings force row level security;
revoke all on table public.field_reading_distribution_settings from public, anon, authenticated;
grant select, insert, update, delete on table public.field_reading_distribution_settings to service_role;

create or replace function public.powerhub_assign_subscriber_field_reader()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_readers bigint[];
  v_address text;
  v_reader bigint;
begin
  if new.archived_at is not null or new.service_status <> 'active' then
    new.assigned_reader_user_id := null;
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'field-reading-distribution:' || new.tenant_id::text || ':' || new.site_id::text, 0
  ));

  select reader_user_ids into v_readers
    from public.field_reading_distribution_settings
   where tenant_id = new.tenant_id and site_id = new.site_id and is_enabled;

  if v_readers is null or cardinality(v_readers) < 2 then
    new.assigned_reader_user_id := null;
    return new;
  end if;

  v_address := nullif(lower(regexp_replace(btrim(coalesce(new.address, '')), '[[:space:]]+', ' ', 'g')), '');

  if v_address is not null then
    select s.assigned_reader_user_id into v_reader
      from public.subscribers s
     where s.tenant_id = new.tenant_id and s.site_id = new.site_id
       and s.archived_at is null and s.service_status = 'active'
       and s.assigned_reader_user_id = any(v_readers)
       and nullif(lower(regexp_replace(btrim(coalesce(s.address, '')), '[[:space:]]+', ' ', 'g')), '') = v_address
       and (tg_op <> 'UPDATE' or s.id <> old.id)
     group by s.assigned_reader_user_id
     order by count(*) desc, s.assigned_reader_user_id
     limit 1;
  end if;

  if v_reader is null then
    select r.reader_id into v_reader
      from unnest(v_readers) r(reader_id)
      left join (
        select assigned_reader_user_id, count(*) n
          from public.subscribers
         where tenant_id = new.tenant_id and site_id = new.site_id
           and archived_at is null and service_status = 'active'
           and assigned_reader_user_id = any(v_readers)
         group by assigned_reader_user_id
      ) c on c.assigned_reader_user_id = r.reader_id
     order by coalesce(c.n, 0), r.reader_id
     limit 1;
  end if;

  new.assigned_reader_user_id := v_reader;
  return new;
end;
$function$;

drop trigger if exists powerhub_assign_subscriber_field_reader on public.subscribers;
create trigger powerhub_assign_subscriber_field_reader
before insert or update of tenant_id, site_id, address, service_status, archived_at
on public.subscribers
for each row execute function public.powerhub_assign_subscriber_field_reader();

revoke all on function public.powerhub_assign_subscriber_field_reader() from public, anon, authenticated;
grant execute on function public.powerhub_assign_subscriber_field_reader() to service_role;

create or replace function public.powerhub_configure_field_reading_distribution(
  p_tenant_id bigint,
  p_site_id bigint,
  p_actor_user_id bigint,
  p_enabled boolean,
  p_reader_user_ids bigint[]
)
returns table(is_enabled boolean, reader_count integer, assigned_subscriber_count bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_readers bigint[] := '{}'::bigint[];
  v_count integer;
  v_distinct integer;
  v_group record;
  v_subscriber_id bigint;
  v_reader bigint;
  v_assigned bigint;
begin
  if not exists (select 1 from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id) then
    raise exception 'FIELD_READING_DISTRIBUTION_SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.tenant_members m
    join public.users u on u.id = m.user_id
    where m.tenant_id = p_tenant_id and m.user_id = p_actor_user_id
      and m.role = 'owner' and m.is_active and m.membership_status = 'active'
      and u.account_status = 'active'
  ) then
    raise exception 'FIELD_READING_DISTRIBUTION_FORBIDDEN' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'field-reading-distribution:' || p_tenant_id::text || ':' || p_site_id::text, 0
  ));

  if coalesce(p_enabled, false) then
    if p_reader_user_ids is null then
      raise exception 'FIELD_READING_DISTRIBUTION_REQUIRES_TWO_READERS' using errcode = '22023';
    end if;
    select cardinality(p_reader_user_ids), count(distinct x.id)::integer
      into v_count, v_distinct from unnest(p_reader_user_ids) x(id);
    if v_count < 2 or v_count <> v_distinct then
      raise exception 'FIELD_READING_DISTRIBUTION_REQUIRES_TWO_READERS' using errcode = '22023';
    end if;

    if exists (
      select 1 from unnest(p_reader_user_ids) x(id)
      where x.id is null or not exists (
        select 1 from public.users u
        join public.tenant_members m on m.user_id = u.id
          and m.tenant_id = p_tenant_id and m.is_active and m.membership_status = 'active'
        join public.staff_profiles p on p.user_id = u.id
          and p.tenant_id = p_tenant_id and p.role = 'technician'
          and p.is_active and p.archived_at is null
          and (p.site_id = p_site_id or p.site_id is null)
          and (p.permissions is null or p.permissions @> '["recordReadings","accessFieldApp"]'::jsonb)
        where u.id = x.id and u.account_status = 'active'
          and not (p.suspension_started_at is not null and p.suspension_started_at <= now()
            and (p.suspension_ends_at is null or p.suspension_ends_at > now()))
      )
    ) then
      raise exception 'FIELD_READING_DISTRIBUTION_INVALID_READER' using errcode = 'P0001';
    end if;

    select array_agg(x.id order by x.id) into v_readers
      from (select distinct unnest(p_reader_user_ids) id) x;

    insert into public.field_reading_distribution_settings
      (tenant_id, site_id, is_enabled, reader_user_ids, updated_by_user_id, updated_at)
    values (p_tenant_id, p_site_id, true, v_readers, p_actor_user_id, now())
    on conflict (tenant_id, site_id) do update
      set is_enabled = true, reader_user_ids = excluded.reader_user_ids,
          updated_by_user_id = excluded.updated_by_user_id, updated_at = now();

    update public.subscribers set assigned_reader_user_id = null
     where tenant_id = p_tenant_id and site_id = p_site_id
       and assigned_reader_user_id is not null;

    -- Allocate complete address groups, largest first, to the least-loaded reader.
    for v_group in
      select normalized_address, array_agg(id order by id) ids
      from (
        select id, nullif(lower(regexp_replace(btrim(coalesce(address, '')), '[[:space:]]+', ' ', 'g')), '') normalized_address
        from public.subscribers
        where tenant_id = p_tenant_id and site_id = p_site_id
          and archived_at is null and service_status = 'active'
      ) s
      where normalized_address is not null
      group by normalized_address
      order by count(*) desc, normalized_address
    loop
      select r.reader_id into v_reader
      from unnest(v_readers) r(reader_id)
      left join (
        select assigned_reader_user_id, count(*) n from public.subscribers
        where tenant_id = p_tenant_id and site_id = p_site_id
          and archived_at is null and service_status = 'active'
          and assigned_reader_user_id = any(v_readers)
        group by assigned_reader_user_id
      ) c on c.assigned_reader_user_id = r.reader_id
      order by coalesce(c.n, 0), r.reader_id limit 1;

      update public.subscribers set assigned_reader_user_id = v_reader
       where id = any(v_group.ids) and tenant_id = p_tenant_id and site_id = p_site_id;
    end loop;

    -- Subscribers without an address are assigned individually.
    for v_subscriber_id in
      select id from public.subscribers
       where tenant_id = p_tenant_id and site_id = p_site_id
         and archived_at is null and service_status = 'active'
         and nullif(btrim(coalesce(address, '')), '') is null
       order by id
    loop
      select r.reader_id into v_reader
      from unnest(v_readers) r(reader_id)
      left join (
        select assigned_reader_user_id, count(*) n from public.subscribers
        where tenant_id = p_tenant_id and site_id = p_site_id
          and archived_at is null and service_status = 'active'
          and assigned_reader_user_id = any(v_readers)
        group by assigned_reader_user_id
      ) c on c.assigned_reader_user_id = r.reader_id
      order by coalesce(c.n, 0), r.reader_id limit 1;
      update public.subscribers set assigned_reader_user_id = v_reader
       where id = v_subscriber_id and tenant_id = p_tenant_id and site_id = p_site_id;
    end loop;

    select count(*) into v_assigned from public.subscribers
     where tenant_id = p_tenant_id and site_id = p_site_id
       and archived_at is null and service_status = 'active'
       and assigned_reader_user_id = any(v_readers);

    insert into public.audit_logs(tenant_id, site_id, user_id, entity_type, entity_id, action, after_data)
    values (p_tenant_id, p_site_id, p_actor_user_id, 'field_reading_distribution', p_site_id::text,
      'configure', jsonb_build_object('enabled', true, 'readerUserIds', to_jsonb(v_readers),
      'readerCount', cardinality(v_readers), 'assignedSubscriberCount', v_assigned));

    return query select true, cardinality(v_readers), v_assigned;
    return;
  end if;

  insert into public.field_reading_distribution_settings
    (tenant_id, site_id, is_enabled, reader_user_ids, updated_by_user_id, updated_at)
  values (p_tenant_id, p_site_id, false, '{}'::bigint[], p_actor_user_id, now())
  on conflict (tenant_id, site_id) do update
    set is_enabled = false, reader_user_ids = '{}'::bigint[],
        updated_by_user_id = excluded.updated_by_user_id, updated_at = now();

  update public.subscribers set assigned_reader_user_id = null
   where tenant_id = p_tenant_id and site_id = p_site_id
     and assigned_reader_user_id is not null;

  insert into public.audit_logs(tenant_id, site_id, user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, p_site_id, p_actor_user_id, 'field_reading_distribution', p_site_id::text,
    'disable', jsonb_build_object('enabled', false, 'readerUserIds', '[]'::jsonb, 'assignedSubscriberCount', 0));

  return query select false, 0, 0::bigint;
end;
$function$;

revoke all on function public.powerhub_configure_field_reading_distribution(bigint,bigint,bigint,boolean,bigint[]) from public, anon, authenticated;
grant execute on function public.powerhub_configure_field_reading_distribution(bigint,bigint,bigint,boolean,bigint[]) to service_role;
