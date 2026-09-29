-- Reconcile the live Production contract with the canonical server adapter.
-- Production previously exposed this RPC with RETURNS void and legacy error codes.
-- The application contract expects a typed row plus stable error identifiers.
-- This migration is idempotent at the contract level by replacing the old signature.

DROP FUNCTION IF EXISTS public.powerhub_admin_set_platform_access_role(bigint, bigint, text);

CREATE OR REPLACE FUNCTION public.powerhub_admin_set_platform_access_role(
  p_actor_user_id bigint,
  p_user_id bigint,
  p_platform_role text
)
RETURNS TABLE(success boolean, platform_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
declare
  v_actor public.users%rowtype;
  v_target public.users%rowtype;
begin
  if p_platform_role not in ('platform_admin', 'finance_admin') then
    raise exception 'INVALID_PLATFORM_ROLE';
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
    raise exception 'SELF_ROLE_CHANGE';
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
     set platform_role = p_platform_role,
         account_status = 'active',
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
    'تغيير دور حساب منصة',
    jsonb_build_object(
      'before', v_target.platform_role,
      'after', p_platform_role,
      'beforeAccountStatus', v_target.account_status,
      'afterAccountStatus', 'active',
      'actorPlatformRole', v_actor.platform_role
    ),
    v_target.id,
    v_actor.id,
    now(),
    now()
  );

  return query
  select true, p_platform_role;
end;
$$;

REVOKE ALL ON FUNCTION public.powerhub_admin_set_platform_access_role(bigint, bigint, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_set_platform_access_role(bigint, bigint, text) TO service_role;
