alter table public.platform_access_invitations
  add column if not exists client_operation_id text,
  add column if not exists request_fingerprint text;

create unique index if not exists platform_access_invitations_client_operation_id_uidx
  on public.platform_access_invitations(client_operation_id)
  where client_operation_id is not null;

drop function if exists public.powerhub_admin_invite_platform_access(bigint,text,text,text,timestamp with time zone);

create function public.powerhub_admin_invite_platform_access(
  p_actor_user_id bigint,
  p_email text,
  p_platform_role text,
  p_token_hash text,
  p_expires_at timestamp with time zone,
  p_client_operation_id text,
  p_request_fingerprint text
)
returns table(id bigint,email text,platform_role text,status text,expires_at timestamp with time zone,replayed boolean)
language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
declare v_role text; v_account_status text; v_id bigint; v_existing public.platform_access_invitations%rowtype;
begin
  if nullif(trim(p_client_operation_id),'') is null then raise exception 'INVALID_OPERATION_ID'; end if;
  if nullif(trim(p_request_fingerprint),'') is null then raise exception 'INVALID_REQUEST_FINGERPRINT'; end if;
  perform pg_advisory_xact_lock(hashtextextended('platform-access-invite:'||trim(p_client_operation_id),0));
  select u.platform_role,u.account_status into v_role,v_account_status from public.users u where u.id=p_actor_user_id and u.role='admin';
  if v_role is null or v_role<>'platform_owner' or v_account_status<>'active' then raise exception 'PLATFORM_OWNER_REQUIRED'; end if;
  if p_platform_role not in ('platform_admin','finance_admin') then raise exception 'INVALID_PLATFORM_ROLE'; end if;
  select i.* into v_existing from public.platform_access_invitations i where i.client_operation_id=trim(p_client_operation_id) limit 1 for update;
  if found then
    if v_existing.request_fingerprint is distinct from p_request_fingerprint
       or lower(v_existing.email) is distinct from lower(trim(p_email))
       or v_existing.platform_role is distinct from p_platform_role
       or v_existing.invited_by_user_id is distinct from p_actor_user_id then raise exception 'OPERATION_CONFLICT'; end if;
    return query select v_existing.id,v_existing.email,v_existing.platform_role,v_existing.status,v_existing.expires_at,true; return;
  end if;
  if exists(select 1 from public.platform_access_invitations i where lower(i.email)=lower(trim(p_email)) and i.status='invited' and i.expires_at>now()) then raise exception 'DUPLICATE_INVITATION'; end if;
  insert into public.platform_access_invitations(email,platform_role,token_hash,status,invited_by_user_id,expires_at,client_operation_id,request_fingerprint)
  values(lower(trim(p_email)),p_platform_role,p_token_hash,'invited',p_actor_user_id,p_expires_at,trim(p_client_operation_id),p_request_fingerprint)
  returning platform_access_invitations.id into v_id;
  insert into public.platform_security_events(event_type,severity,status,title,created_by_user_id,metadata)
  values('security_change','info','success','دعوة وصول لإدارة المنصة',p_actor_user_id,jsonb_build_object('invitationId',v_id,'email',lower(trim(p_email)),'platformRole',p_platform_role,'expiresAt',p_expires_at,'clientOperationId',trim(p_client_operation_id)));
  return query select i.id,i.email,i.platform_role,i.status,i.expires_at,false from public.platform_access_invitations i where i.id=v_id;
end;
$function$;

revoke all on function public.powerhub_admin_invite_platform_access(bigint,text,text,text,timestamp with time zone,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_invite_platform_access(bigint,text,text,text,timestamp with time zone,text,text) to service_role;