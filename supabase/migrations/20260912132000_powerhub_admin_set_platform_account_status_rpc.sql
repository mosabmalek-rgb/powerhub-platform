create or replace function public.powerhub_admin_set_platform_account_status(
  p_actor_user_id bigint,
  p_user_id bigint,
  p_account_status text
)
returns table(success boolean, account_status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.users%rowtype;
  v_target public.users%rowtype;
begin
  if p_account_status not in ('active', 'locked', 'disabled') then
    raise exception 'INVALID_ACCOUNT_STATUS';
  end if;

  select *
    into v_actor
    from public.users
   where id = p_actor_user_id
     and role = 'admin'
     and platform_role = 'platform_owner'
     and account_status = 'active'
   for update;

  if not found then
    raise exception 'FORBIDDEN';
  end if;

  if p_user_id = p_actor_user_id then
    raise exception 'SELF_STATUS_CHANGE';
  end if;

  select *
    into v_target
    from public.users
   where id = p_user_id
     and role = 'admin'
   for update;

  if not found then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  if v_target.platform_role = 'platform_owner' then
    raise exception 'PLATFORM_OWNER_PROTECTED';
  end if;

  update public.users
     set account_status = p_account_status,
         updated_at = now()
   where id = v_target.id;

  insert into public.platform_security_events(
    event_type,
    severity,
    status,
    title,
    metadata,
    related_user_id,
    created_by_user_id,
    created_at,
    updated_at
  )
  values (
    'security_change',
    'info',
    'success',
    'تغيير حالة حساب منصة',
    jsonb_build_object(
      'before', v_target.account_status,
      'after', p_account_status,
      'targetPlatformRole', v_target.platform_role,
      'actorPlatformRole', v_actor.platform_role
    ),
    v_target.id,
    v_actor.id,
    now(),
    now()
  );

  return query
  select true, p_account_status;
end;
$$;

revoke all on function public.powerhub_admin_set_platform_account_status(bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.powerhub_admin_set_platform_account_status(bigint, bigint, text) to service_role;
