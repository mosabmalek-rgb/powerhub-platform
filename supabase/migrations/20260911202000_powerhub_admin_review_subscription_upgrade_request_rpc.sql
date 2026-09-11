-- Atomic Supabase replacement for the guarded admin subscription-upgrade review write.

create or replace function public.powerhub_admin_review_subscription_upgrade_request(
  p_actor_user_id bigint,
  p_request_id bigint,
  p_decision text,
  p_note text default null
)
returns table(success boolean, plan text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_platform_role text;
  v_request public.subscription_upgrade_requests%rowtype;
  v_site_id bigint;
  v_plan text;
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

  if p_decision not in ('approved', 'rejected') then
    raise exception 'INVALID_DECISION' using errcode = '22023';
  end if;

  select sur.*
  into v_request
  from public.subscription_upgrade_requests as sur
  where sur.id = p_request_id
  for update;

  if not found then
    raise exception 'REQUEST_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_request.status not in ('pending', 'reviewing') then
    raise exception 'REQUEST_ALREADY_PROCESSED' using errcode = 'P0001';
  end if;

  select s.id
  into v_site_id
  from public.sites as s
  where s.tenant_id = v_request.tenant_id
  order by s.id
  limit 1;

  if v_site_id is null then
    raise exception 'SITE_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.subscription_upgrade_requests
  set status = p_decision,
      note = p_note,
      reviewed_by_user_id = p_actor_user_id,
      reviewed_at = now(),
      updated_at = now()
  where id = v_request.id;

  v_plan := case when p_decision = 'approved' then v_request.requested_plan else v_request.current_plan end;

  if p_decision = 'approved' then
    update public.tenants
    set plan = v_request.requested_plan,
        updated_at = now()
    where id = v_request.tenant_id;

    update public.tenant_subscriptions
    set plan = v_request.requested_plan,
        updated_at = now()
    where tenant_id = v_request.tenant_id;
  end if;

  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role,
    entity_type, entity_id, action, after_data
  ) values (
    v_request.tenant_id, v_site_id, p_actor_user_id, v_actor_platform_role,
    'subscription_upgrade_request', v_request.id::text,
    'platform_admin_' || p_decision || '_subscription_upgrade',
    jsonb_build_object(
      'requestedPlan', v_request.requested_plan,
      'decision', p_decision,
      'note', p_note
    )
  );

  return query select true, v_plan;
end;
$$;

revoke all on function public.powerhub_admin_review_subscription_upgrade_request(bigint, bigint, text, text) from public, anon, authenticated;
grant execute on function public.powerhub_admin_review_subscription_upgrade_request(bigint, bigint, text, text) to service_role;
