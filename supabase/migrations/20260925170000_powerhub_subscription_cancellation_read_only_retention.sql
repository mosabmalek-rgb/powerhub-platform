-- PowerHub subscription lifecycle: cancellation -> 10-day read-only retention -> archival.
alter table public.tenant_subscriptions
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by_user_id bigint references public.users(id) on delete set null,
  add column if not exists cancellation_reason text,
  add column if not exists read_only_until timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by_user_id bigint references public.users(id) on delete set null,
  add column if not exists archive_reason text;

create index if not exists tenant_subscriptions_read_only_until_idx
  on public.tenant_subscriptions (read_only_until)
  where read_only_until is not null and archived_at is null;

create or replace function public.powerhub_admin_cancel_tenant_subscription(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_grace_days integer default 10,
  p_reason text default null
)
returns table(
  success boolean,
  tenant_id bigint,
  subscription_id bigint,
  read_only_until timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_platform_role text;
  v_subscription public.tenant_subscriptions%rowtype;
  v_site_id bigint;
  v_read_only_until timestamptz;
begin
  select u.platform_role into v_actor_platform_role
  from public.users u
  where u.id=p_actor_user_id
    and u.role='admin'
    and u.account_status='active'
    and u.platform_role in ('platform_owner','platform_admin');
  if v_actor_platform_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
  end if;

  if p_grace_days is null or p_grace_days < 1 or p_grace_days > 30 then
    raise exception 'INVALID_GRACE_DAYS' using errcode='22023';
  end if;

  select ts.* into v_subscription
  from public.tenant_subscriptions ts
  where ts.tenant_id=p_tenant_id
  order by ts.created_at desc, ts.id desc
  limit 1
  for update;

  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode='P0002';
  end if;

  if v_subscription.archived_at is not null then
    raise exception 'SUBSCRIPTION_ALREADY_ARCHIVED' using errcode='P0001';
  end if;

  if v_subscription.status='cancelled' then
    if v_subscription.read_only_until is not null and v_subscription.read_only_until > now() then
      return query select true,p_tenant_id,v_subscription.id,v_subscription.read_only_until;
      return;
    end if;
    raise exception 'SUBSCRIPTION_ALREADY_CANCELLED' using errcode='P0001';
  end if;

  v_read_only_until := now() + make_interval(days => p_grace_days);

  update public.tenant_subscriptions
  set status='cancelled',
      auto_renew=false,
      cancelled_at=now(),
      cancelled_by_user_id=p_actor_user_id,
      cancellation_reason=nullif(trim(coalesce(p_reason,'')), ''),
      read_only_until=v_read_only_until,
      updated_at=now()
  where id=v_subscription.id;

  update public.tenants
  set status='active',
      updated_at=now()
  where id=p_tenant_id;

  select s.id into v_site_id
  from public.sites s
  where s.tenant_id=p_tenant_id
  order by s.id
  limit 1;
  if v_site_id is null then
    raise exception 'TENANT_SITE_REQUIRED_FOR_AUDIT' using errcode='P0001';
  end if;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data,metadata
  ) values(
    p_tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,
    'tenant_subscription',v_subscription.id::text,'platform_admin_cancel_subscription',
    jsonb_build_object(
      'status','cancelled',
      'readOnlyUntil',v_read_only_until,
      'graceDays',p_grace_days,
      'reason',nullif(trim(coalesce(p_reason,'')), '')
    ),
    jsonb_build_object('dataRetention','read_only')
  );

  return query select true,p_tenant_id,v_subscription.id,v_read_only_until;
end;
$$;

revoke all on function public.powerhub_admin_cancel_tenant_subscription(bigint,bigint,integer,text)
  from public, anon, authenticated;
grant execute on function public.powerhub_admin_cancel_tenant_subscription(bigint,bigint,integer,text)
  to service_role;

create or replace function public.powerhub_admin_restore_tenant_subscription(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_reason text default null
)
returns table(
  success boolean,
  tenant_id bigint,
  subscription_id bigint,
  ends_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_platform_role text;
  v_subscription public.tenant_subscriptions%rowtype;
  v_site_id bigint;
begin
  select u.platform_role into v_actor_platform_role
  from public.users u
  where u.id=p_actor_user_id
    and u.role='admin'
    and u.account_status='active'
    and u.platform_role in ('platform_owner','platform_admin');
  if v_actor_platform_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
  end if;

  select ts.* into v_subscription
  from public.tenant_subscriptions ts
  where ts.tenant_id=p_tenant_id
  order by ts.created_at desc, ts.id desc
  limit 1
  for update;

  if not found then raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode='P0002'; end if;
  if v_subscription.archived_at is not null then raise exception 'SUBSCRIPTION_ALREADY_ARCHIVED' using errcode='P0001'; end if;
  if v_subscription.status<>'cancelled' then raise exception 'SUBSCRIPTION_NOT_CANCELLED' using errcode='P0001'; end if;
  if v_subscription.read_only_until is null or v_subscription.read_only_until <= now() then
    raise exception 'READ_ONLY_WINDOW_EXPIRED' using errcode='P0001';
  end if;
  if v_subscription.ends_at <= now() then
    raise exception 'ORIGINAL_SUBSCRIPTION_EXPIRED' using errcode='P0001';
  end if;

  update public.tenant_subscriptions
  set status='active',
      cancelled_at=null,
      cancelled_by_user_id=null,
      cancellation_reason=null,
      read_only_until=null,
      updated_at=now()
  where id=v_subscription.id;

  update public.tenants
  set status='active',
      updated_at=now()
  where id=p_tenant_id;

  select s.id into v_site_id from public.sites s where s.tenant_id=p_tenant_id order by s.id limit 1;
  if v_site_id is null then
    raise exception 'TENANT_SITE_REQUIRED_FOR_AUDIT' using errcode='P0001';
  end if;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data,metadata
  ) values(
    p_tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,
    'tenant_subscription',v_subscription.id::text,'platform_admin_restore_subscription',
    jsonb_build_object('status','active','endsAt',v_subscription.ends_at,'reason',nullif(trim(coalesce(p_reason,'')), '')),
    jsonb_build_object('dataRetention','restored')
  );

  return query select true,p_tenant_id,v_subscription.id,v_subscription.ends_at;
end;
$$;

revoke all on function public.powerhub_admin_restore_tenant_subscription(bigint,bigint,text)
  from public, anon, authenticated;
grant execute on function public.powerhub_admin_restore_tenant_subscription(bigint,bigint,text)
  to service_role;

create or replace function public.powerhub_archive_expired_subscription_read_only()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
  v_row record;
begin
  for v_row in
    select ts.id,ts.tenant_id,s.id as site_id
    from public.tenant_subscriptions ts
    join lateral (
      select s.id
      from public.sites s
      where s.tenant_id=ts.tenant_id
      order by s.id
      limit 1
    ) s on true
    where ts.status='cancelled'
      and ts.archived_at is null
      and ts.read_only_until is not null
      and ts.read_only_until <= now()
    order by ts.read_only_until asc
    for update of ts skip locked
  loop
    update public.tenant_subscriptions
    set archived_at=now(),
        archive_reason='انتهاء فترة الاحتفاظ للقراءة فقط',
        updated_at=now()
    where id=v_row.id;

    update public.tenants
    set status='archived',
        updated_at=now()
    where id=v_row.tenant_id;

    insert into public.audit_logs(
      tenant_id,site_id,user_id,entity_type,entity_id,action,after_data,metadata
    )
    values(v_row.tenant_id,v_row.site_id,null,'tenant_subscription',v_row.id::text,
      'system_archive_subscription',
      jsonb_build_object('archivedAt',now()),
      jsonb_build_object('dataRetention','archived')
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.powerhub_archive_expired_subscription_read_only() from public, anon, authenticated;
grant execute on function public.powerhub_archive_expired_subscription_read_only() to service_role;

do $$
begin
  perform cron.unschedule('powerhub-subscription-lifecycle-archive')
  where exists (select 1 from cron.job where jobname='powerhub-subscription-lifecycle-archive');
exception when others then
  null;
end;
$$;

select cron.schedule(
  'powerhub-subscription-lifecycle-archive',
  '15 2 * * *',
  $$select public.powerhub_archive_expired_subscription_read_only();$$
);
