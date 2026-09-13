create or replace function public.powerhub_admin_request_owner_access_recovery(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_note text default null
)
returns table (success boolean, recovery_request_id bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_platform_role text;
  v_owner_user_id bigint;
  v_request_id bigint;
  v_note text;
begin
  select platform_role
    into v_actor_platform_role
  from public.users
  where id = p_actor_user_id
    and role = 'admin'
    and account_status = 'active'
    and platform_role in ('platform_owner', 'platform_admin');

  if v_actor_platform_role is null then
    raise exception using errcode = '42501', message = 'FORBIDDEN: منصة PowerHub لا تملك صلاحية طلب استرداد الوصول.';
  end if;

  if p_tenant_id is null or p_tenant_id <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_TENANT_ID';
  end if;

  v_note := nullif(btrim(p_note), '');
  if v_note is not null and char_length(v_note) > 2000 then
    raise exception using errcode = '22023', message = 'INVALID_NOTE';
  end if;

  if not exists (select 1 from public.tenants where id = p_tenant_id) then
    raise exception using errcode = 'P0002', message = 'TENANT_NOT_FOUND';
  end if;

  select owner_user_id
    into v_owner_user_id
  from public.tenant_owner_profiles
  where tenant_id = p_tenant_id
  limit 1;

  if v_owner_user_id is null then
    raise exception using errcode = 'P0002', message = 'OWNER_PROFILE_NOT_FOUND';
  end if;

  insert into public.access_recovery_requests (
    tenant_id,
    owner_user_id,
    requested_by_user_id,
    method,
    status,
    note
  )
  values (
    p_tenant_id,
    v_owner_user_id,
    p_actor_user_id,
    'oauth_invite',
    'pending',
    v_note
  )
  returning id into v_request_id;

  insert into public.platform_security_events (
    event_type,
    severity,
    status,
    title,
    details,
    metadata,
    related_user_id,
    created_by_user_id
  )
  values (
    'security_change',
    'info',
    'success',
    'طلب استرداد وصول صاحب مولد',
    'تم إنشاء طلب استرداد وصول موثق دون إرسال قناة خارجية.',
    jsonb_build_object(
      'tenantId', p_tenant_id,
      'ownerUserId', v_owner_user_id,
      'recoveryRequestId', v_request_id,
      'method', 'oauth_invite',
      'status', 'pending'
    ),
    v_owner_user_id,
    p_actor_user_id
  );

  return query select true, v_request_id;
end;
$$;

revoke all on function public.powerhub_admin_request_owner_access_recovery(bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.powerhub_admin_request_owner_access_recovery(bigint, bigint, text) to service_role;
