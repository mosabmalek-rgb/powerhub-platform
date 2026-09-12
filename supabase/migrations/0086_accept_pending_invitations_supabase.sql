-- Supabase-native replacement for the legacy MySQL invitation acceptance
-- previously embedded in server/db.ts.
-- This migration is additive and intentionally does not touch Production.

create or replace function public.powerhub_accept_pending_platform_invitation(
  p_auth_user_id uuid,
  p_email text
)
returns table(accepted boolean, invitation_id bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id bigint;
  v_invitation public.platform_access_invitations%rowtype;
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  if p_auth_user_id is null or v_email = '' then
    return query select false, null::bigint;
    return;
  end if;

  select u.id
    into v_user_id
  from public.users u
  where u.auth_user_id = p_auth_user_id
  limit 1;

  if v_user_id is null then
    raise exception 'USER_PROFILE_NOT_FOUND';
  end if;

  select i.*
    into v_invitation
  from public.platform_access_invitations i
  where lower(trim(i.email)) = v_email
    and i.status = 'invited'
    and i.expires_at >= now()
  order by i.created_at desc, i.id desc
  limit 1
  for update;

  if not found then
    return query select false, null::bigint;
    return;
  end if;

  update public.users
  set role = 'admin',
      platform_role = v_invitation.platform_role,
      account_status = 'active',
      updated_at = now()
  where id = v_user_id;

  update public.platform_access_invitations
  set status = 'accepted',
      accepted_by_user_id = v_user_id,
      accepted_at = now(),
      updated_at = now()
  where id = v_invitation.id;

  return query select true, v_invitation.id;
end;
$$;

revoke all on function public.powerhub_accept_pending_platform_invitation(uuid, text) from public;
revoke all on function public.powerhub_accept_pending_platform_invitation(uuid, text) from anon;
revoke all on function public.powerhub_accept_pending_platform_invitation(uuid, text) from authenticated;
grant execute on function public.powerhub_accept_pending_platform_invitation(uuid, text) to service_role;

create or replace function public.powerhub_accept_pending_tenant_invitations(
  p_auth_user_id uuid,
  p_email text
)
returns table(accepted_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id bigint;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_invitation public.access_invitations%rowtype;
  v_count integer := 0;
begin
  if p_auth_user_id is null or v_email = '' then
    return query select 0;
    return;
  end if;

  select u.id
    into v_user_id
  from public.users u
  where u.auth_user_id = p_auth_user_id
  limit 1;

  if v_user_id is null then
    raise exception 'USER_PROFILE_NOT_FOUND';
  end if;

  for v_invitation in
    select i.*
    from public.access_invitations i
    where lower(trim(i.email)) = v_email
      and i.status = 'invited'
      and i.expires_at >= now()
    order by i.created_at asc, i.id asc
    for update
  loop
    insert into public.tenant_members (
      tenant_id,
      user_id,
      role,
      is_active,
      membership_status,
      invited_by_user_id,
      expires_at,
      created_at,
      updated_at
    )
    values (
      v_invitation.tenant_id,
      v_user_id,
      v_invitation.tenant_role,
      true,
      'active',
      v_invitation.invited_by_user_id,
      null,
      now(),
      now()
    )
    on conflict (tenant_id, user_id) do update
      set role = excluded.role,
          is_active = true,
          membership_status = 'active',
          invited_by_user_id = excluded.invited_by_user_id,
          expires_at = null,
          updated_at = now();

    if v_invitation.site_id is not null and v_invitation.site_role is not null then
      insert into public.staff_profiles (
        user_id,
        tenant_id,
        site_id,
        role,
        is_active,
        created_at,
        updated_at
      )
      values (
        v_user_id,
        v_invitation.tenant_id,
        v_invitation.site_id,
        v_invitation.site_role,
        true,
        now(),
        now()
      )
      on conflict (user_id, site_id, role) do update
        set is_active = true,
            tenant_id = excluded.tenant_id,
            updated_at = now();
    end if;

    if v_invitation.tenant_role = 'owner' then
      update public.tenant_owner_profiles
      set owner_user_id = v_user_id,
          claimed_at = now(),
          updated_at = now()
      where tenant_id = v_invitation.tenant_id;
    end if;

    update public.access_invitations
    set status = 'accepted',
        accepted_by_user_id = v_user_id,
        accepted_at = now(),
        updated_at = now()
    where id = v_invitation.id;

    v_count := v_count + 1;
  end loop;

  return query select v_count;
end;
$$;

revoke all on function public.powerhub_accept_pending_tenant_invitations(uuid, text) from public;
revoke all on function public.powerhub_accept_pending_tenant_invitations(uuid, text) from anon;
revoke all on function public.powerhub_accept_pending_tenant_invitations(uuid, text) from authenticated;
grant execute on function public.powerhub_accept_pending_tenant_invitations(uuid, text) to service_role;
