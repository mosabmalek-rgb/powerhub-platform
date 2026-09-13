create or replace function public.powerhub_admin_request_owner_access_recovery(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_note text default null
)
returns table(success boolean, recovery_request_id bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.users%rowtype;
  v_owner_user_id bigint;
  v_site_id bigint;
  v_request_id bigint;
begin
  if p_tenant_id is null or p_tenant_id <= 0 then
    raise exception 'INVALID_TENANT_ID';
  end if;

  if p_note is not null and char_length(p_note) > 2000 then
    raise exception 'INVALID_NOTE';
  end if;

  select *
    into v_actor
    from public.users
   where id = p_actor_user_id
     and role = 'admin'
     and platform_role in ('platform_owner', 'platform_admin')
     and account_status = 'active'
   for update;

  if not found then
    raise exception 'FORBIDDEN';
  end if;

  select top_profile.owner_user_id
    into v_owner_user_id
    from public.tenant_owner_profiles top_profile
   where top_profile.tenant_id = p_tenant_id
   limit 1;

  if v_owner_user_id is null then
    raise exception 'OWNER_PROFILE_NOT_FOUND';
  end if;

  if not exists (select 1 from public.tenants where id = p_tenant_id) then
    raise exception 'TENANT_NOT_FOUND';
  end if;

  select s.id
    into v_site_id
    from public.sites s
   where s.tenant_id = p_tenant_id
   order by s.id
   limit 1;

  insert into public.access_recovery_requests(
    tenant_id,
    owner_user_id,
    requested_by_user_id,
    method,
    status,
    note
  )
  values(
    p_tenant_id,
    v_owner_user_id,
    v_actor.id,
    'oauth_invite',
    'pending',
    nullif(btrim(p_note), '')
  )
  returning id into v_request_id;

  if v_site_id is not null then
    insert into public.audit_logs(
      tenant_id,
      site_id,
      user_id,
      actor_platform_role,
      entity_type,
      entity_id,
      action,
      after_data
    )
    values(
      p_tenant_id,
      v_site_id,
      v_actor.id,
      v_actor.platform_role,
      'access_recovery',
      v_request_id::text,
      'platform_admin_request_owner_access_recovery',
      jsonb_build_object(
        'tenantId', p_tenant_id,
        'ownerUserId', v_owner_user_id,
        'method', 'oauth_invite',
        'status', 'pending',
        'delivery', 'deferred'
      )
    );
  end if;

  insert into public.platform_security_events(
    event_type,
    severity,
    status,
    title,
    details,
    metadata,
    created_by_user_id
  )
  values(
    'security_change',
    'info',
    'success',
    'طلب استرداد وصول صاحب المولد',
    'تم إنشاء طلب استرداد وصول عبر مسار Supabase الإداري.',
    jsonb_build_object(
      'tenantId', p_tenant_id,
      'recoveryRequestId', v_request_id,
      'method', 'oauth_invite',
      'status', 'pending',
      'delivery', 'deferred'
    ),
    v_actor.id
  );

  return query select true, v_request_id;
end;
$$;

revoke all on function public.powerhub_admin_request_owner_access_recovery(bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.powerhub_admin_request_owner_access_recovery(bigint, bigint, text) to service_role;
