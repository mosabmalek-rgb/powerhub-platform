drop function if exists public.powerhub_accept_pending_tenant_invitations(uuid,text);

create function public.powerhub_accept_pending_tenant_invitations(
  p_auth_user_id uuid,
  p_email text
)
returns table(accepted_count integer)
language plpgsql security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_user_id bigint;
  v_email text := lower(trim(coalesce(p_email,'')));
  v_invitation public.access_invitations%rowtype;
  v_member public.tenant_members%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_owner_user_id bigint;
  v_count integer := 0;
begin
  if p_auth_user_id is null or v_email='' then return query select 0; return; end if;

  select u.id into v_user_id
  from public.users u where u.auth_user_id=p_auth_user_id limit 1;
  if v_user_id is null then raise exception 'USER_PROFILE_NOT_FOUND'; end if;

  perform pg_advisory_xact_lock(hashtextextended('tenant-invite-accept-user:'||v_user_id::text,0));

  for v_invitation in
    select i.* from public.access_invitations i
    where lower(trim(i.email))=v_email
      and i.status='invited'
      and i.expires_at>=now()
    order by i.created_at asc,i.id asc
    for update
  loop
    perform pg_advisory_xact_lock(hashtextextended('tenant-invite-accept-tenant:'||v_invitation.tenant_id::text,0));

    if v_invitation.tenant_role='owner' then
      select top1.owner_user_id into v_owner_user_id
      from public.tenant_owner_profiles top1
      where top1.tenant_id=v_invitation.tenant_id
      for update;
      if v_owner_user_id is null then raise exception 'OWNER_PROFILE_NOT_FOUND'; end if;
    end if;

    select * into v_member from public.tenant_members tm
    where tm.tenant_id=v_invitation.tenant_id and tm.user_id=v_user_id for update;

    if not found then
      insert into public.tenant_members(tenant_id,user_id,role,is_active,membership_status,invited_by_user_id,expires_at,created_at,updated_at)
      values(v_invitation.tenant_id,v_user_id,v_invitation.tenant_role,true,'active',v_invitation.invited_by_user_id,null,now(),now());
    elsif v_member.role is distinct from v_invitation.tenant_role
       or v_member.is_active is distinct from true
       or v_member.membership_status is distinct from 'active'
       or v_member.invited_by_user_id is distinct from v_invitation.invited_by_user_id
       or v_member.expires_at is not null then
      update public.tenant_members
      set role=v_invitation.tenant_role,is_active=true,membership_status='active',
          invited_by_user_id=v_invitation.invited_by_user_id,expires_at=null,updated_at=now()
      where id=v_member.id;
    end if;

    if v_invitation.site_id is not null and v_invitation.site_role is not null then
      select * into v_staff from public.staff_profiles sp
      where sp.user_id=v_user_id and sp.site_id=v_invitation.site_id and sp.role=v_invitation.site_role
      for update;
      if not found then
        insert into public.staff_profiles(user_id,tenant_id,site_id,role,is_active,created_at,updated_at)
        values(v_user_id,v_invitation.tenant_id,v_invitation.site_id,v_invitation.site_role,true,now(),now());
      elsif v_staff.is_active is distinct from true or v_staff.tenant_id is distinct from v_invitation.tenant_id then
        update public.staff_profiles
        set is_active=true,tenant_id=v_invitation.tenant_id,updated_at=now()
        where id=v_staff.id;
      end if;
    end if;

    if v_invitation.tenant_role='owner' and v_owner_user_id is distinct from v_user_id then
      update public.tenant_owner_profiles
      set owner_user_id=v_user_id,claimed_at=now(),updated_at=now()
      where tenant_id=v_invitation.tenant_id;
    end if;

    update public.access_invitations
    set status='accepted',accepted_by_user_id=v_user_id,accepted_at=now(),updated_at=now()
    where id=v_invitation.id;

    insert into public.platform_security_events(event_type,severity,status,title,details,metadata,related_user_id,created_by_user_id)
    values('security_change','info','success','قبول دعوة وصول إلى المستأجر',
      'تم قبول دعوة وصول وربط الحساب بالمساحة وفق العقد الإداري.',
      jsonb_build_object('tenantId',v_invitation.tenant_id,'siteId',v_invitation.site_id,'invitationId',v_invitation.id,'tenantRole',v_invitation.tenant_role,'siteRole',v_invitation.site_role,'userId',v_user_id),
      v_user_id,v_invitation.invited_by_user_id);

    v_count:=v_count+1;
  end loop;
  return query select v_count;
end;
$function$;

revoke all on function public.powerhub_accept_pending_tenant_invitations(uuid,text) from public,anon,authenticated;
grant execute on function public.powerhub_accept_pending_tenant_invitations(uuid,text) to service_role;