drop function if exists public.powerhub_accept_pending_platform_invitation(uuid,text);

create function public.powerhub_accept_pending_platform_invitation(
  p_auth_user_id uuid,
  p_email text
)
returns table(accepted boolean, platform_role text, invitation_id bigint, replayed boolean)
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_invitation public.platform_access_invitations%rowtype;
  v_user public.users%rowtype;
  v_email text := lower(trim(coalesce(p_email,'')));
begin
  if p_auth_user_id is null or v_email='' then
    return query select false,null::text,null::bigint,false;
    return;
  end if;

  select *
    into v_user
  from public.users
  where auth_user_id=p_auth_user_id
  for update;

  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;

  if lower(trim(coalesce(v_user.email,''))) is distinct from v_email then
    raise exception 'EMAIL_MISMATCH';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('platform-invite-accept-user:'||v_user.id::text,0)
  );

  select *
    into v_invitation
  from public.platform_access_invitations
  where lower(trim(email))=v_email
    and status='invited'
    and expires_at>now()
  order by created_at desc,id desc
  limit 1
  for update;

  if not found then
    return query select false,v_user.platform_role,null::bigint,false;
    return;
  end if;

  if v_user.platform_role='platform_owner' then
    raise exception 'PLATFORM_OWNER_CANNOT_BE_REINVITED';
  end if;

  if v_user.role='admin' or v_user.platform_role is not null then
    raise exception 'PLATFORM_ACCESS_ALREADY_ASSIGNED';
  end if;

  update public.users
  set role='admin',
      platform_role=v_invitation.platform_role,
      account_status='active',
      updated_at=now()
  where id=v_user.id;

  update public.platform_access_invitations
  set status='accepted',
      accepted_by_user_id=v_user.id,
      accepted_at=now(),
      updated_at=now()
  where id=v_invitation.id;

  insert into public.platform_security_events(
    event_type,severity,status,title,metadata,related_user_id,created_at,updated_at
  )
  values(
    'security_change','info','success','قبول دعوة إدارة المنصة',
    jsonb_build_object(
      'invitationId',v_invitation.id,
      'email',v_email,
      'platformRole',v_invitation.platform_role,
      'userId',v_user.id
    ),
    v_user.id,now(),now()
  );

  return query select true,v_invitation.platform_role,v_invitation.id,false;
end;
$function$;

revoke all on function public.powerhub_accept_pending_platform_invitation(uuid,text) from public,anon,authenticated;
grant execute on function public.powerhub_accept_pending_platform_invitation(uuid,text) to service_role;