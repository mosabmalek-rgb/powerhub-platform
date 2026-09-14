-- Atomic Supabase replacement for the guarded admin quick-upgrade write.

create or replace function public.powerhub_admin_quick_upgrade_owner_plan(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_plan text,
  p_note text default null
)
returns table(success boolean, plan text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_platform_role text;
  v_tenant public.tenants%rowtype;
  v_subscription public.tenant_subscriptions%rowtype;
  v_site_id bigint;
  v_current_rank integer;
  v_requested_rank integer;
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

  if p_plan not in ('starter', 'professional', 'enterprise') then
    raise exception 'INVALID_PLAN' using errcode = '22023';
  end if;

  select t.*
  into v_tenant
  from public.tenants as t
  where t.id = p_tenant_id
  for update;

  if not found then
    raise exception 'TENANT_NOT_FOUND' using errcode = 'P0002';
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

  v_current_rank := case v_tenant.plan
    when 'starter' then 1
    when 'professional' then 2
    when 'enterprise' then 3
  end;
  v_requested_rank := case p_plan
    when 'starter' then 1
    when 'professional' then 2
    when 'enterprise' then 3
  end;

  if v_requested_rank <= v_current_rank then
    raise exception 'PLAN_NOT_UPGRADE' using errcode = '22023';
  end if;

  update public.tenants
  set plan = p_plan,
      updated_at = now()
  where id = p_tenant_id;

  update public.tenant_subscriptions
  set plan = p_plan,
      updated_at = now()
  where id = v_subscription.id;

  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role,
    entity_type, entity_id, action, after_data
  ) values (
    p_tenant_id, v_site_id, p_actor_user_id, v_actor_platform_role,
    'tenant_subscription', p_tenant_id::text,
    'platform_admin_quick_upgrade_owner_plan',
    jsonb_build_object(
      'fromPlan', v_tenant.plan,
      'toPlan', p_plan,
      'note', p_note
    )
  );

  return query select true, p_plan;
end;
$$;

revoke all on function public.powerhub_admin_quick_upgrade_owner_plan(bigint, bigint, text, text) from public, anon, authenticated;
grant execute on function public.powerhub_admin_quick_upgrade_owner_plan(bigint, bigint, text, text) to service_role;
