-- PowerHub: migrate the visible platform-admin complaint update action to Supabase.
-- The operation is atomic, tenant/site scoped, audited, and service-role only.

create or replace function public.powerhub_update_complaint(
  p_actor_user_id bigint,
  p_complaint_id bigint,
  p_status text,
  p_assigned_user_id bigint default null,
  p_response text default null
)
returns table(
  id bigint,
  status text,
  assigned_user_id bigint,
  response text,
  resolved_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_platform_role text;
  v_complaint public.complaints%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_resolved_at timestamptz;
  v_assignee_ok boolean := false;
begin
  select u.platform_role
    into v_actor_platform_role
    from public.users u
   where u.id = p_actor_user_id
     and u.role = 'admin'
     and u.account_status = 'active'
     and u.platform_role in ('platform_owner', 'platform_admin');

  if v_actor_platform_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode = '42501';
  end if;

  if p_status not in ('open', 'assigned', 'in_progress', 'resolved', 'closed') then
    raise exception 'INVALID_COMPLAINT_STATUS' using errcode = '22023';
  end if;

  select c.*
    into v_complaint
    from public.complaints c
   where c.id = p_complaint_id
   for update;

  if not found then
    raise exception 'COMPLAINT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_assigned_user_id is not null then
    select exists (
      select 1
        from public.users u
       where u.id = p_assigned_user_id
         and u.account_status = 'active'
         and (
           (
             u.role = 'admin'
             and u.platform_role in ('platform_owner', 'platform_admin')
           )
           or exists (
             select 1
               from public.tenant_members tm
              where tm.tenant_id = v_complaint.tenant_id
                and tm.user_id = u.id
                and tm.is_active = true
                and tm.membership_status = 'active'
                and exists (
                  select 1
                    from public.staff_profiles sp
                   where sp.tenant_id = v_complaint.tenant_id
                     and sp.user_id = u.id
                     and sp.is_active = true
                     and (sp.site_id = v_complaint.site_id or sp.site_id is null)
                )
           )
         )
    )
      into v_assignee_ok;

    if not v_assignee_ok then
      raise exception 'ASSIGNEE_OUT_OF_SCOPE' using errcode = '42501';
    end if;
  end if;

  v_before := jsonb_build_object(
    'status', v_complaint.status,
    'assignedUserId', v_complaint.assigned_user_id,
    'response', v_complaint.response,
    'resolvedAt', v_complaint.resolved_at
  );

  v_resolved_at := case
    when p_status in ('resolved', 'closed') then coalesce(v_complaint.resolved_at, now())
    else null
  end;

  update public.complaints c
     set status = p_status,
         assigned_user_id = p_assigned_user_id,
         response = nullif(btrim(p_response), ''),
         resolved_at = v_resolved_at,
         updated_at = now()
   where c.id = p_complaint_id
   returning c.id, c.status, c.assigned_user_id, c.response, c.resolved_at
   into id, status, assigned_user_id, response, resolved_at;

  v_after := jsonb_build_object(
    'status', status,
    'assignedUserId', assigned_user_id,
    'response', response,
    'resolvedAt', resolved_at
  );

  insert into public.audit_logs(
    tenant_id,
    site_id,
    user_id,
    actor_platform_role,
    entity_type,
    entity_id,
    action,
    before_data,
    after_data
  ) values (
    v_complaint.tenant_id,
    v_complaint.site_id,
    p_actor_user_id,
    v_actor_platform_role,
    'complaint',
    p_complaint_id::text,
    'platform_admin_update_complaint',
    v_before,
    v_after
  );

  return next;
end;
$$;

revoke all on function public.powerhub_update_complaint(bigint,bigint,text,bigint,text) from public, anon, authenticated;
grant execute on function public.powerhub_update_complaint(bigint,bigint,text,bigint,text) to service_role;
