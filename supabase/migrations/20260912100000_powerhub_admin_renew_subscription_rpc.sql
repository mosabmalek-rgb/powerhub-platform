-- Atomic Supabase replacement for the guarded admin subscription-renewal write.

create or replace function public.powerhub_admin_renew_subscription(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_periods integer default 1
)
returns table(success boolean, ends_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_platform_role text;
  v_subscription public.tenant_subscriptions%rowtype;
  v_site_id bigint;
  v_base timestamptz;
  v_ends_at timestamptz;
  v_period interval;
begin
  select u.platform_role
  into v_actor_platform_role
  from public.users as u
  where u.id = p_actor_user_id
    and u.role = 'admin'
    and u.account_status = 'active'
    and u.platform_role in ('platform_owner', 'platform_admin');

  if v_actor_platform_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode = '42501';
  end if;

  if p_periods < 1 or p_periods > 24 then
    raise exception 'INVALID_PERIODS' using errcode = '22023';
  end if;

  select ts.*
  into v_subscription
  from public.tenant_subscriptions as ts
  where ts.tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select s.id
  into v_site_id
  from public.sites as s
  where s.tenant_id = p_tenant_id
  order by s.id
  limit 1;

  if v_site_id is null then
    raise exception 'SITE_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_base := greatest(v_subscription.ends_at, now());

  v_period := case v_subscription.billing_cycle
    when 'monthly' then make_interval(months => p_periods)
    when 'yearly' then make_interval(years => p_periods)
    else null
  end;

  if v_period is null then
    raise exception 'INVALID_BILLING_CYCLE' using errcode = '22023';
  end if;

  v_ends_at := v_base + v_period;

  update public.tenant_subscriptions
  set status = 'active',
      ends_at = v_ends_at,
      renewal_count = renewal_count + p_periods,
      last_renewed_at = now(),
      updated_at = now()
  where id = v_subscription.id;

  update public.tenants
  set status = 'active',
      updated_at = now()
  where id = p_tenant_id;

  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role,
    entity_type, entity_id, action, after_data
  ) values (
    p_tenant_id, v_site_id, p_actor_user_id, v_actor_platform_role,
    'tenant_subscription', v_subscription.id::text,
    'platform_admin_renew_subscription',
    jsonb_build_object(
      'periods', p_periods,
      'billingCycle', v_subscription.billing_cycle,
      'previousEndsAt', v_subscription.ends_at,
      'endsAt', v_ends_at
    )
  );

  return query select true, v_ends_at;
end;
$$;

revoke all on function public.powerhub_admin_renew_subscription(bigint, bigint, integer) from public, anon, authenticated;
grant execute on function public.powerhub_admin_renew_subscription(bigint, bigint, integer) to service_role;
