create or replace function public.powerhub_admin_review_subscription_upgrade_request(
  p_actor_user_id bigint,p_request_id bigint,p_decision text,p_note text default null)
returns table(success boolean,plan text,replayed boolean)
language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_role text;v_request public.subscription_upgrade_requests%rowtype;v_site_id bigint;v_plan text;v_replay boolean:=false;
begin
 select platform_role into v_role from public.users where id=p_actor_user_id and role='admin' and account_status='active' and platform_role in('platform_owner','platform_admin');
 if v_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
 if p_decision not in('approved','rejected') then raise exception 'INVALID_DECISION' using errcode='22023'; end if;
 select * into v_request from public.subscription_upgrade_requests where id=p_request_id for update;
 if not found then raise exception 'REQUEST_NOT_FOUND' using errcode='P0002'; end if;
 if v_request.status not in('pending','reviewing') then
   if v_request.status=p_decision then
     select s.id into v_site_id from public.sites s where s.tenant_id=v_request.tenant_id order by s.id limit 1;
     if v_site_id is null then raise exception 'SITE_NOT_FOUND' using errcode='P0002'; end if;
     v_plan:=case when p_decision='approved' then v_request.requested_plan else v_request.current_plan end;
     v_replay:=true;
     return query select true,v_plan,true; return;
   end if;
   raise exception 'REQUEST_ALREADY_PROCESSED' using errcode='P0001';
 end if;
 select s.id into v_site_id from public.sites s where s.tenant_id=v_request.tenant_id order by s.id limit 1;
 if v_site_id is null then raise exception 'SITE_NOT_FOUND' using errcode='P0002'; end if;
 update public.subscription_upgrade_requests set status=p_decision,note=p_note,reviewed_by_user_id=p_actor_user_id,reviewed_at=now(),updated_at=now() where id=v_request.id;
 v_plan:=case when p_decision='approved' then v_request.requested_plan else v_request.current_plan end;
 if p_decision='approved' then
   update public.tenants set plan=v_request.requested_plan,updated_at=now() where id=v_request.tenant_id;
   update public.tenant_subscriptions set plan=v_request.requested_plan,updated_at=now() where tenant_id=v_request.tenant_id;
 end if;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
 values(v_request.tenant_id,v_site_id,p_actor_user_id,v_role,'subscription_upgrade_request',v_request.id::text,'platform_admin_'||p_decision||'_subscription_upgrade',jsonb_build_object('requestedPlan',v_request.requested_plan,'decision',p_decision,'note',p_note));
 return query select true,v_plan,false;
end;$$;
revoke all on function public.powerhub_admin_review_subscription_upgrade_request(bigint,bigint,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_review_subscription_upgrade_request(bigint,bigint,text,text) to service_role;

create or replace function public.powerhub_admin_review_sms_package_request(
 p_actor_user_id bigint,p_request_id bigint,p_status text,p_approved_messages integer,p_note text default null)
returns table(success boolean,tenant_id bigint,site_id bigint,status text,approved_messages integer,replayed boolean)
language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_role text;v_request public.sms_package_requests%rowtype;v_site_id bigint;
begin
 select platform_role into v_role from public.users where id=p_actor_user_id and role='admin' and account_status='active' and platform_role in('platform_owner','platform_admin');
 if v_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
 if p_status not in('approved','rejected') then raise exception 'INVALID_STATUS' using errcode='22023'; end if;
 if p_approved_messages<0 then raise exception 'INVALID_APPROVED_MESSAGES' using errcode='22023'; end if;
 if p_status='approved' and p_approved_messages<1 then raise exception 'APPROVED_MESSAGES_REQUIRED' using errcode='22023'; end if;
 select * into v_request from public.sms_package_requests where id=p_request_id for update;
 if not found then raise exception 'REQUEST_NOT_FOUND' using errcode='P0002'; end if;
 if v_request.status<>'pending' then
   if v_request.status=p_status and (p_status='rejected' or coalesce(v_request.approved_messages,0)=p_approved_messages) then
     select s.id into v_site_id from public.sites s where s.tenant_id=v_request.tenant_id order by s.id limit 1;
     if v_site_id is null then raise exception 'SITE_NOT_FOUND' using errcode='P0002'; end if;
     return query select true,v_request.tenant_id,v_site_id,p_status,case when p_status='approved' then p_approved_messages else 0 end,true; return;
   end if;
   raise exception 'REQUEST_ALREADY_PROCESSED' using errcode='55000';
 end if;
 select s.id into v_site_id from public.sites s where s.tenant_id=v_request.tenant_id order by s.id limit 1;
 if v_site_id is null then raise exception 'SITE_NOT_FOUND' using errcode='P0002'; end if;
 update public.sms_package_requests set status=p_status,approved_messages=case when p_status='approved' then p_approved_messages else 0 end,note=p_note,reviewed_by_user_id=p_actor_user_id,reviewed_at=now(),updated_at=now() where id=p_request_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data) values(v_request.tenant_id,v_site_id,p_actor_user_id,v_role,'sms_package_request',p_request_id::text,case when p_status='approved' then 'platform_admin_approved_sms_package_request' else 'platform_admin_rejected_sms_package_request' end,jsonb_build_object('status',v_request.status,'approvedMessages',v_request.approved_messages),jsonb_build_object('status',p_status,'approvedMessages',case when p_status='approved' then p_approved_messages else 0 end,'note',p_note));
 return query select true,v_request.tenant_id,v_site_id,p_status,case when p_status='approved' then p_approved_messages else 0 end,false;
end;$$;
revoke all on function public.powerhub_admin_review_sms_package_request(bigint,bigint,text,integer,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_review_sms_package_request(bigint,bigint,text,integer,text) to service_role;