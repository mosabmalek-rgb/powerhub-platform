create or replace function public.powerhub_admin_invite_platform_access(
  p_actor_user_id bigint,
  p_email text,
  p_platform_role text,
  p_expires_in_hours integer default 72
)
returns table(id bigint, email text, platform_role text, expires_at timestamptz, status text)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_actor public.users%rowtype;
  v_existing public.users%rowtype;
  v_invitation public.platform_access_invitations%rowtype;
  v_email text := lower(trim(p_email));
  v_expires_at timestamptz;
begin
  if p_expires_in_hours is null or p_expires_in_hours < 1 or p_expires_in_hours > 168 then raise exception 'INVALID_EXPIRATION'; end if;
  select * into v_actor from public.users where id = p_actor_user_id and role = 'admin' and platform_role = 'platform_owner' and account_status = 'active' for update;
  if not found then raise exception 'FORBIDDEN'; end if;
  if v_email is null or v_email = '' or position('@' in v_email) < 2 then raise exception 'INVALID_EMAIL'; end if;
  if p_platform_role not in ('platform_admin', 'finance_admin') then raise exception 'INVALID_PLATFORM_ROLE'; end if;
  select * into v_existing from public.users where lower(email) = v_email limit 1;
  if found and (v_existing.role = 'admin' or v_existing.platform_role is not null) then raise exception 'ACCOUNT_ALREADY_EXISTS'; end if;
  update public.platform_access_invitations set status = 'expired', updated_at = now() where lower(email) = v_email and status = 'invited' and expires_at <= now();
  if exists (select 1 from public.platform_access_invitations where lower(email) = v_email and status = 'invited' and expires_at > now()) then raise exception 'INVITATION_ALREADY_PENDING'; end if;
  v_expires_at := now() + make_interval(hours => p_expires_in_hours);
  insert into public.platform_access_invitations(email, platform_role, token_hash, invited_by_user_id, expires_at, status, created_at, updated_at)
  values (v_email, p_platform_role, encode(gen_random_bytes(32), 'hex'), p_actor_user_id, v_expires_at, 'invited', now(), now()) returning * into v_invitation;
  insert into public.platform_security_events(event_type, severity, status, title, metadata, created_by_user_id, created_at, updated_at)
  values ('security_change', 'info', 'success', 'دعوة دور منصة', jsonb_build_object('invitationId', v_invitation.id, 'email', v_email, 'platformRole', p_platform_role, 'expiresAt', v_expires_at), p_actor_user_id, now(), now());
  return query select v_invitation.id, v_invitation.email, v_invitation.platform_role, v_invitation.expires_at, v_invitation.status;
end;
$$;

create or replace function public.powerhub_accept_pending_platform_invitation(p_auth_user_id uuid, p_email text)
returns table(accepted boolean, platform_role text, invitation_id bigint)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_invitation public.platform_access_invitations%rowtype;
  v_user public.users%rowtype;
  v_email text := lower(trim(p_email));
begin
  select * into v_invitation from public.platform_access_invitations where lower(email) = v_email and status = 'invited' order by created_at desc limit 1 for update;
  if not found then return query select false, null::text, null::bigint; return; end if;
  if v_invitation.expires_at <= now() then update public.platform_access_invitations set status = 'expired', updated_at = now() where id = v_invitation.id; return query select false, null::text, v_invitation.id; return; end if;
  select * into v_user from public.users where auth_user_id = p_auth_user_id for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_user.platform_role = 'platform_owner' then return query select false, v_user.platform_role, v_invitation.id; return; end if;
  update public.users set role = 'admin', platform_role = v_invitation.platform_role, account_status = 'active', updated_at = now() where id = v_user.id;
  update public.platform_access_invitations set status = 'accepted', accepted_at = now(), updated_at = now() where id = v_invitation.id;
  insert into public.platform_security_events(event_type, severity, status, title, metadata, related_user_id, created_at, updated_at)
  values ('security_change', 'info', 'success', 'قبول دعوة إدارة المنصة', jsonb_build_object('invitationId', v_invitation.id, 'email', v_email, 'platformRole', v_invitation.platform_role), v_user.id, now(), now());
  return query select true, v_invitation.platform_role, v_invitation.id;
end;
$$;

revoke all on function public.powerhub_admin_invite_platform_access(bigint, text, text, integer) from public, anon, authenticated;
grant execute on function public.powerhub_admin_invite_platform_access(bigint, text, text, integer) to service_role;
revoke all on function public.powerhub_accept_pending_platform_invitation(uuid, text) from public, anon, authenticated;
grant execute on function public.powerhub_accept_pending_platform_invitation(uuid, text) to service_role;
