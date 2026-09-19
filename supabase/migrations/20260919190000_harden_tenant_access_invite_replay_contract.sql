alter table public.access_invitations add column if not exists client_operation_id text, add column if not exists request_fingerprint text;
create unique index if not exists access_invitations_client_operation_id_uidx on public.access_invitations(client_operation_id) where client_operation_id is not null;
drop function if exists public.powerhub_admin_invite_tenant_access(bigint,bigint,bigint,text,text,text,text,timestamp with time zone);
create function public.powerhub_admin_invite_tenant_access(p_actor_user_id bigint,p_tenant_id bigint,p_site_id bigint,p_email text,p_tenant_role text,p_site_role text,p_token_hash text,p_expires_at timestamp with time zone,p_client_operation_id text,p_request_fingerprint text)
returns table(invitation_id bigint,email text,expires_at timestamp with time zone,status text,replayed boolean)
language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
declare v_site_id bigint:=p_site_id; v_site_role text:=p_site_role; v_invitation_id bigint; v_existing public.access_invitations%rowtype;
begin
 if nullif(trim(p_client_operation_id),'') is null then raise exception 'INVALID_OPERATION_ID'; end if;
 if nullif(trim(p_request_fingerprint),'') is null then raise exception 'INVALID_REQUEST_FINGERPRINT'; end if;
 perform pg_advisory_xact_lock(hashtextextended('tenant-access-invite-operation:'||trim(p_client_operation_id),0));
 perform pg_advisory_xact_lock(hashtextextended('tenant-access-invite-target:'||p_tenant_id::text||':'||lower(trim(p_email)),0));
 if not exists(select 1 from public.users where id=p_actor_user_id and role='admin' and account_status='active' and platform_role in ('platform_owner','platform_admin')) then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
 if p_tenant_id is null or p_tenant_id<=0 then raise exception 'INVALID_TENANT_ID'; end if;
 if not exists(select 1 from public.tenants where id=p_tenant_id) then raise exception 'TENANT_NOT_FOUND'; end if;
 if nullif(trim(p_email),'') is null or length(trim(p_email))>320 then raise exception 'INVALID_EMAIL'; end if;
 if p_tenant_role not in ('owner','admin','member') then raise exception 'INVALID_TENANT_ROLE'; end if;
 if p_site_role is not null and p_site_role not in ('owner','manager','accountant','collector','technician','viewer') then raise exception 'INVALID_SITE_ROLE'; end if;
 if nullif(trim(p_token_hash),'') is null or length(p_token_hash)>128 then raise exception 'INVALID_TOKEN_HASH'; end if;
 if p_expires_at is null or p_expires_at<=now() then raise exception 'INVALID_EXPIRY'; end if;
 if v_site_id is not null and not exists(select 1 from public.sites where id=v_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_NOT_FOUND'; end if;
 if p_tenant_role='owner' then v_site_role:='owner'; end if;
 select * into v_existing from public.access_invitations where client_operation_id=trim(p_client_operation_id) for update;
 if found then
   if v_existing.request_fingerprint is distinct from p_request_fingerprint or v_existing.tenant_id is distinct from p_tenant_id or v_existing.site_id is distinct from v_site_id or lower(v_existing.email) is distinct from lower(trim(p_email)) or v_existing.tenant_role is distinct from p_tenant_role or v_existing.site_role is distinct from v_site_role or v_existing.invited_by_user_id is distinct from p_actor_user_id then raise exception 'OPERATION_CONFLICT'; end if;
   return query select v_existing.id,v_existing.email,v_existing.expires_at,v_existing.status,true; return;
 end if;
 if exists(select 1 from public.access_invitations i where i.tenant_id=p_tenant_id and lower(i.email)=lower(trim(p_email)) and i.status='invited' and i.expires_at>now()) then raise exception 'DUPLICATE_INVITATION'; end if;
 insert into public.access_invitations(tenant_id,site_id,email,tenant_role,site_role,token_hash,status,invited_by_user_id,expires_at,client_operation_id,request_fingerprint)
 values(p_tenant_id,v_site_id,lower(trim(p_email)),p_tenant_role,v_site_role,p_token_hash,'invited',p_actor_user_id,p_expires_at,trim(p_client_operation_id),p_request_fingerprint)
 returning id into v_invitation_id;
 insert into public.platform_security_events(event_type,severity,status,title,details,metadata,created_by_user_id)
 values('security_change','info','success','دعوة وصول إلى المستأجر','تم إنشاء دعوة وصول للمستأجر من خلال مسار Supabase الإداري.',jsonb_build_object('tenantId',p_tenant_id,'siteId',v_site_id,'invitationId',v_invitation_id,'email',lower(trim(p_email)),'tenantRole',p_tenant_role,'siteRole',v_site_role,'status','invited','expiresAt',p_expires_at,'clientOperationId',trim(p_client_operation_id)),p_actor_user_id);
 return query select v_invitation_id,lower(trim(p_email)),p_expires_at,'invited',false;
end;
$function$;
revoke all on function public.powerhub_admin_invite_tenant_access(bigint,bigint,bigint,text,text,text,text,timestamp with time zone,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_invite_tenant_access(bigint,bigint,bigint,text,text,text,text,timestamp with time zone,text,text) to service_role;