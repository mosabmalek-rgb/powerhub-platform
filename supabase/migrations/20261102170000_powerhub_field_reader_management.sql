-- Field-reader operations: subscription quota, unassigned queue, transfers, reconciliation.
-- All management reads/writes are exposed only through service-role RPCs.

create or replace function public.powerhub_guard_field_reading_distribution_quota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_limit integer;
begin
  if new.is_enabled then
    v_limit := public.powerhub_effective_tenant_quota(new.tenant_id, 'fieldUser');
    if cardinality(coalesce(new.reader_user_ids, '{}'::bigint[])) > coalesce(v_limit, 0) then
      raise exception 'FIELD_READING_DISTRIBUTION_FIELD_USER_LIMIT_REACHED' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists field_reading_distribution_quota_guard on public.field_reading_distribution_settings;
create trigger field_reading_distribution_quota_guard
before insert or update of is_enabled, reader_user_ids, tenant_id
on public.field_reading_distribution_settings
for each row execute function public.powerhub_guard_field_reading_distribution_quota();

revoke all on function public.powerhub_guard_field_reading_distribution_quota() from public, anon, authenticated;
grant execute on function public.powerhub_guard_field_reading_distribution_quota() to service_role;


create or replace function public.powerhub_list_field_reading_assignments(
  p_tenant_id bigint,
  p_site_id bigint,
  p_search text default null,
  p_only_unassigned boolean default true,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  subscriber_id bigint,
  subscriber_no text,
  full_name text,
  phone text,
  address text,
  created_at timestamptz,
  assigned_reader_user_id bigint,
  assigned_reader_name text,
  assigned_reader_email text,
  is_unassigned boolean,
  unassigned_reason text,
  total_count bigint
)
language sql
security definer
set search_path = public, pg_temp
as $function$
  with scoped as (
    select
      s.id,
      s.subscriber_no,
      s.full_name,
      s.phone,
      s.address,
      s.created_at,
      s.assigned_reader_user_id,
      assigned_user.name as assigned_reader_name,
      assigned_user.email as assigned_reader_email,
      coalesce(settings.is_enabled, false) as distribution_enabled,
      case
        when s.assigned_reader_user_id is null then 'missing_assignment'
        when not exists (
          select 1
            from unnest(coalesce(settings.reader_user_ids, '{}'::bigint[])) configured(reader_id)
            join public.users reader on reader.id = configured.reader_id
            join public.tenant_members membership
              on membership.user_id = reader.id
             and membership.tenant_id = p_tenant_id
             and membership.is_active = true
             and membership.membership_status = 'active'
            join public.staff_profiles profile
              on profile.user_id = reader.id
             and profile.tenant_id = p_tenant_id
             and profile.role = 'technician'
             and profile.is_active = true
             and profile.archived_at is null
             and (profile.site_id = p_site_id or profile.site_id is null)
             and (
               profile.permissions is null
               or profile.permissions @> '["recordReadings","accessFieldApp"]'::jsonb
             )
           where reader.id = s.assigned_reader_user_id
             and reader.account_status = 'active'
             and not (
               profile.suspension_started_at is not null
               and profile.suspension_started_at <= now()
               and (profile.suspension_ends_at is null or profile.suspension_ends_at > now())
             )
        ) then 'reader_ineligible'
        else null
      end as unassigned_reason
    from public.subscribers s
    left join public.users assigned_user on assigned_user.id = s.assigned_reader_user_id
    left join public.field_reading_distribution_settings settings
      on settings.tenant_id = s.tenant_id and settings.site_id = s.site_id
    where s.tenant_id = p_tenant_id
      and s.site_id = p_site_id
      and s.archived_at is null
      and s.service_status = 'active'
      and (
        nullif(btrim(coalesce(p_search, '')), '') is null
        or coalesce(s.subscriber_no, '') ilike '%' || btrim(p_search) || '%'
        or coalesce(s.full_name, '') ilike '%' || btrim(p_search) || '%'
        or coalesce(s.phone, '') ilike '%' || btrim(p_search) || '%'
        or coalesce(s.address, '') ilike '%' || btrim(p_search) || '%'
      )
  )
  select
    scoped.id,
    scoped.subscriber_no,
    scoped.full_name,
    scoped.phone,
    scoped.address,
    scoped.created_at,
    scoped.assigned_reader_user_id,
    scoped.assigned_reader_name,
    scoped.assigned_reader_email,
    scoped.unassigned_reason is not null,
    scoped.unassigned_reason,
    count(*) over()::bigint
  from scoped
  where not p_only_unassigned
     or (scoped.distribution_enabled and scoped.unassigned_reason is not null)
  order by scoped.created_at desc nulls last, scoped.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
$function$;

revoke all on function public.powerhub_list_field_reading_assignments(bigint,bigint,text,boolean,integer,integer) from public, anon, authenticated;
grant execute on function public.powerhub_list_field_reading_assignments(bigint,bigint,text,boolean,integer,integer) to service_role;


create or replace function public.powerhub_move_subscriber_field_reader(
  p_tenant_id bigint,
  p_site_id bigint,
  p_actor_user_id bigint,
  p_subscriber_id bigint,
  p_target_reader_user_id bigint
)
returns table(subscriber_id bigint, previous_reader_user_id bigint, assigned_reader_user_id bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_settings public.field_reading_distribution_settings%rowtype;
  v_previous_reader bigint;
  v_quota integer;
begin
  if not exists (
    select 1
      from public.sites site
     where site.id = p_site_id
       and site.tenant_id = p_tenant_id
       and site.status = 'active'
  ) then
    raise exception 'FIELD_READING_DISTRIBUTION_SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  if not exists (
    select 1
      from public.users actor
      join public.tenant_members membership
        on membership.user_id = actor.id
       and membership.tenant_id = p_tenant_id
       and membership.role = 'owner'
       and membership.is_active = true
       and membership.membership_status = 'active'
     where actor.id = p_actor_user_id
       and actor.account_status = 'active'
  ) then
    raise exception 'FIELD_READING_DISTRIBUTION_FORBIDDEN' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'field-reading-distribution:' || p_tenant_id::text || ':' || p_site_id::text, 0
  ));

  select * into v_settings
    from public.field_reading_distribution_settings
   where tenant_id = p_tenant_id and site_id = p_site_id
   for update;

  if not found or not v_settings.is_enabled then
    raise exception 'FIELD_READING_DISTRIBUTION_NOT_ENABLED' using errcode = 'P0001';
  end if;

  v_quota := public.powerhub_effective_tenant_quota(p_tenant_id, 'fieldUser');
  if cardinality(v_settings.reader_user_ids) > coalesce(v_quota, 0) then
    raise exception 'FIELD_READING_DISTRIBUTION_FIELD_USER_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  if not (p_target_reader_user_id = any(v_settings.reader_user_ids)) then
    raise exception 'FIELD_READING_DISTRIBUTION_INVALID_READER' using errcode = 'P0001';
  end if;

  if not exists (
    select 1
      from public.users reader
      join public.tenant_members membership
        on membership.user_id = reader.id
       and membership.tenant_id = p_tenant_id
       and membership.is_active = true
       and membership.membership_status = 'active'
      join public.staff_profiles profile
        on profile.user_id = reader.id
       and profile.tenant_id = p_tenant_id
       and profile.role = 'technician'
       and profile.is_active = true
       and profile.archived_at is null
       and (profile.site_id = p_site_id or profile.site_id is null)
       and (
         profile.permissions is null
         or profile.permissions @> '["recordReadings","accessFieldApp"]'::jsonb
       )
     where reader.id = p_target_reader_user_id
       and reader.account_status = 'active'
       and not (
         profile.suspension_started_at is not null
         and profile.suspension_started_at <= now()
         and (profile.suspension_ends_at is null or profile.suspension_ends_at > now())
       )
  ) then
    raise exception 'FIELD_READING_DISTRIBUTION_INVALID_READER' using errcode = 'P0001';
  end if;

  select subscriber.assigned_reader_user_id into v_previous_reader
    from public.subscribers subscriber
   where subscriber.id = p_subscriber_id
     and subscriber.tenant_id = p_tenant_id
     and subscriber.site_id = p_site_id
     and subscriber.archived_at is null
     and subscriber.service_status = 'active'
   for update;

  if not found then
    raise exception 'FIELD_READING_DISTRIBUTION_SUBSCRIBER_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_previous_reader = p_target_reader_user_id then
    raise exception 'FIELD_READING_DISTRIBUTION_ALREADY_ASSIGNED' using errcode = 'P0001';
  end if;

  update public.subscribers
     set assigned_reader_user_id = p_target_reader_user_id
   where id = p_subscriber_id
     and tenant_id = p_tenant_id
     and site_id = p_site_id;

  insert into public.audit_logs
    (tenant_id, site_id, user_id, entity_type, entity_id, action, after_data)
  values
    (p_tenant_id, p_site_id, p_actor_user_id, 'field_reading_distribution',
     p_subscriber_id::text, 'move_subscriber',
     jsonb_build_object(
       'subscriberId', p_subscriber_id,
       'previousReaderUserId', v_previous_reader,
       'assignedReaderUserId', p_target_reader_user_id
     ));

  return query select p_subscriber_id, v_previous_reader, p_target_reader_user_id;
end;
$function$;

revoke all on function public.powerhub_move_subscriber_field_reader(bigint,bigint,bigint,bigint,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_move_subscriber_field_reader(bigint,bigint,bigint,bigint,bigint) to service_role;


create or replace function public.powerhub_reconcile_field_reader_selection(
  p_tenant_id bigint,
  p_user_id bigint,
  p_site_id bigint default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_setting record;
  v_eligible boolean;
  v_remaining_readers bigint[];
begin
  for v_setting in
    select settings.tenant_id, settings.site_id, settings.is_enabled, settings.reader_user_ids
      from public.field_reading_distribution_settings settings
     where (p_tenant_id is null or settings.tenant_id = p_tenant_id)
       and (p_site_id is null or settings.site_id = p_site_id)
       and (
         p_user_id = any(settings.reader_user_ids)
         or exists (
           select 1 from public.subscribers subscriber
            where subscriber.tenant_id = settings.tenant_id
              and subscriber.site_id = settings.site_id
              and subscriber.assigned_reader_user_id = p_user_id
         )
       )
     for update
  loop
    select exists (
      select 1
        from public.users reader
        join public.tenant_members membership
          on membership.user_id = reader.id
         and membership.tenant_id = v_setting.tenant_id
         and membership.is_active = true
         and membership.membership_status = 'active'
        join public.staff_profiles profile
          on profile.user_id = reader.id
         and profile.tenant_id = v_setting.tenant_id
         and profile.role = 'technician'
         and profile.is_active = true
         and profile.archived_at is null
         and (profile.site_id = v_setting.site_id or profile.site_id is null)
         and (
           profile.permissions is null
           or profile.permissions @> '["recordReadings","accessFieldApp"]'::jsonb
         )
       where reader.id = p_user_id
         and reader.account_status = 'active'
         and not (
           profile.suspension_started_at is not null
           and profile.suspension_started_at <= now()
           and (profile.suspension_ends_at is null or profile.suspension_ends_at > now())
         )
    ) into v_eligible;

    if not v_setting.is_enabled
       or not (p_user_id = any(v_setting.reader_user_ids))
       or not v_eligible then
      if v_setting.is_enabled and p_user_id = any(v_setting.reader_user_ids) then
        v_remaining_readers := array_remove(v_setting.reader_user_ids, p_user_id);
        if cardinality(v_remaining_readers) < 2 then
          update public.field_reading_distribution_settings
             set is_enabled = false,
                 reader_user_ids = '{}'::bigint[],
                 updated_at = now()
           where tenant_id = v_setting.tenant_id and site_id = v_setting.site_id;

          update public.subscribers
             set assigned_reader_user_id = null
           where tenant_id = v_setting.tenant_id and site_id = v_setting.site_id;

          insert into public.audit_logs
            (tenant_id, site_id, user_id, entity_type, entity_id, action, after_data)
          values
            (v_setting.tenant_id, v_setting.site_id, null, 'field_reading_distribution',
             v_setting.site_id::text, 'auto_disable_no_active_readers',
             jsonb_build_object('disabledUserId', p_user_id, 'remainingReaderCount', cardinality(v_remaining_readers)));
        else
          update public.field_reading_distribution_settings
             set reader_user_ids = v_remaining_readers,
                 updated_at = now()
           where tenant_id = v_setting.tenant_id and site_id = v_setting.site_id;

          update public.subscribers
             set assigned_reader_user_id = null
           where tenant_id = v_setting.tenant_id
             and site_id = v_setting.site_id
             and assigned_reader_user_id = p_user_id;

          insert into public.audit_logs
            (tenant_id, site_id, user_id, entity_type, entity_id, action, after_data)
          values
            (v_setting.tenant_id, v_setting.site_id, null, 'field_reading_distribution',
             p_user_id::text, 'remove_ineligible_reader',
             jsonb_build_object('remainingReaderUserIds', to_jsonb(v_remaining_readers)));
        end if;
      else
        update public.subscribers
           set assigned_reader_user_id = null
         where tenant_id = v_setting.tenant_id
           and site_id = v_setting.site_id
           and assigned_reader_user_id = p_user_id;
      end if;
    end if;
  end loop;
end;
$function$;

revoke all on function public.powerhub_reconcile_field_reader_selection(bigint,bigint,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_reconcile_field_reader_selection(bigint,bigint,bigint) to service_role;


create or replace function public.powerhub_reconcile_field_reader_after_profile_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if tg_op = 'UPDATE' then
    perform public.powerhub_reconcile_field_reader_selection(old.tenant_id, old.user_id, old.site_id);
  end if;
  perform public.powerhub_reconcile_field_reader_selection(new.tenant_id, new.user_id, new.site_id);
  return new;
end;
$function$;

drop trigger if exists powerhub_reconcile_field_reader_after_profile_change on public.staff_profiles;
create trigger powerhub_reconcile_field_reader_after_profile_change
after update of role, is_active, permissions, suspension_started_at, suspension_ends_at, site_id
or delete on public.staff_profiles
for each row execute function public.powerhub_reconcile_field_reader_after_profile_change();

revoke all on function public.powerhub_reconcile_field_reader_after_profile_change() from public, anon, authenticated;
grant execute on function public.powerhub_reconcile_field_reader_after_profile_change() to service_role;


create or replace function public.powerhub_reconcile_field_reader_after_user_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if tg_op = 'DELETE' or new.account_status <> 'active' then
    perform public.powerhub_reconcile_field_reader_selection(null, coalesce(new.id, old.id), null);
  end if;
  return coalesce(new, old);
end;
$function$;

drop trigger if exists powerhub_reconcile_field_reader_after_user_change on public.users;
create trigger powerhub_reconcile_field_reader_after_user_change
after update of account_status or delete on public.users
for each row execute function public.powerhub_reconcile_field_reader_after_user_change();

revoke all on function public.powerhub_reconcile_field_reader_after_user_change() from public, anon, authenticated;
grant execute on function public.powerhub_reconcile_field_reader_after_user_change() to service_role;


create or replace function public.powerhub_reconcile_field_reader_after_membership_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if tg_op = 'DELETE' then
    perform public.powerhub_reconcile_field_reader_selection(old.tenant_id, old.user_id, null);
  elsif new.is_active is not true or new.membership_status <> 'active' then
    perform public.powerhub_reconcile_field_reader_selection(new.tenant_id, new.user_id, null);
  end if;
  return coalesce(new, old);
end;
$function$;

drop trigger if exists powerhub_reconcile_field_reader_after_membership_change on public.tenant_members;
create trigger powerhub_reconcile_field_reader_after_membership_change
after update of is_active, membership_status or delete on public.tenant_members
for each row execute function public.powerhub_reconcile_field_reader_after_membership_change();

revoke all on function public.powerhub_reconcile_field_reader_after_membership_change() from public, anon, authenticated;
grant execute on function public.powerhub_reconcile_field_reader_after_membership_change() to service_role;
