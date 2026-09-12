create or replace function public.powerhub_admin_save_role_policy(
  p_actor_user_id bigint,
  p_role text,
  p_capability text,
  p_is_allowed boolean
)
returns table (
  success boolean,
  policy_id bigint,
  role text,
  capability text,
  is_allowed boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.users%rowtype;
  v_policy public.platform_role_policies%rowtype;
begin
  if p_actor_user_id is null then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode = 'P0001';
  end if;

  select * into v_actor
  from public.users
  where id = p_actor_user_id
    and account_status = 'active'
    and platform_role in ('platform_owner', 'platform_admin')
  for share;

  if not found then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode = 'P0001';
  end if;

  if p_role not in ('owner', 'manager', 'accountant', 'collector', 'technician', 'viewer') then
    raise exception 'INVALID_ROLE' using errcode = 'P0001';
  end if;

  if p_capability not in (
    'manageSubscribers', 'manageGenerators', 'recordReadings', 'accessFieldApp',
    'approveReadings', 'manageTariffs', 'issueInvoices', 'collectPayments',
    'manageExpenses', 'managePayroll', 'manageTeam', 'manageMessaging', 'viewAudit'
  ) then
    raise exception 'INVALID_CAPABILITY' using errcode = 'P0001';
  end if;

  insert into public.platform_role_policies(role, capability, is_allowed, updated_by_user_id, updated_at)
  values (p_role, p_capability, p_is_allowed, v_actor.id, now())
  on conflict (role, capability)
  do update set
    is_allowed = excluded.is_allowed,
    updated_by_user_id = excluded.updated_by_user_id,
    updated_at = now()
  returning * into v_policy;

  insert into public.platform_security_events(
    event_type, severity, status, title, details, metadata, created_by_user_id
  ) values (
    'security_change',
    'info',
    'success',
    'تحديث سياسة صلاحيات المنصة',
    'تم تحديث سياسة صلاحية لدور داخل المنصة بصورة ذرية.',
    jsonb_build_object(
      'role', v_policy.role,
      'capability', v_policy.capability,
      'isAllowed', v_policy.is_allowed,
      'policyId', v_policy.id,
      'actorPlatformRole', v_actor.platform_role
    ),
    v_actor.id
  );

  return query select true, v_policy.id, v_policy.role, v_policy.capability, v_policy.is_allowed;
end;
$$;

revoke all on function public.powerhub_admin_save_role_policy(bigint, text, text, boolean) from public;
revoke all on function public.powerhub_admin_save_role_policy(bigint, text, text, boolean) from anon;
revoke all on function public.powerhub_admin_save_role_policy(bigint, text, text, boolean) from authenticated;
grant execute on function public.powerhub_admin_save_role_policy(bigint, text, text, boolean) to service_role;
