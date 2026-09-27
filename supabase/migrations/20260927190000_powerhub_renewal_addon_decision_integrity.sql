-- Harden renewal addon decisions: validate the complete decision set before mutating subscription/addons.
-- Invalid/missing/cross-tenant/duplicate addon decisions must fail atomically.

create or replace function public.powerhub_admin_renew_subscription_with_addons(
 p_actor_user_id bigint,
 p_subscription_id bigint,
 p_new_ends_at timestamptz,
 p_addon_decisions jsonb default '[]'::jsonb
)
returns table(success boolean,ends_at timestamptz,renewed_addons integer,expired_addons integer)
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
 s public.tenant_subscriptions%rowtype;
 v_tenant_status text;
 v_site_id bigint;
 d jsonb;
 a public.tenant_addon_requests%rowtype;
 v_renewed int:=0;
 v_expired int:=0;
 v_duration int;
 v_new_end timestamptz;
 v_actor_platform_role text;
 v_addon_request_id bigint;
 v_decision text;
 v_seen_addon_ids bigint[] := '{}'::bigint[];
begin
 select platform_role into v_actor_platform_role
 from public.users
 where id=p_actor_user_id
   and role='admin'
   and account_status='active'
   and platform_role in ('platform_owner','platform_admin');

 if v_actor_platform_role is null then
   raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
 end if;

 select * into s
 from public.tenant_subscriptions
 where id=p_subscription_id
 for update;

 if not found then
   raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode='P0001';
 end if;

 select status into v_tenant_status
 from public.tenants
 where id=s.tenant_id;

 if v_tenant_status='archived' or s.status='archived' then
   raise exception 'ARCHIVED_SUBSCRIPTION_RENEWAL_FORBIDDEN' using errcode='42501';
 end if;

 if p_new_ends_at<=now() then
   raise exception 'INVALID_RENEWAL_END_DATE' using errcode='P0001';
 end if;

 select site_id into v_site_id
 from public.tenant_addon_requests
 where tenant_id=s.tenant_id and site_id is not null
 order by created_at desc
 limit 1;

 if v_site_id is null then
   select id into v_site_id
   from public.sites
   where tenant_id=s.tenant_id and status<>'archived'
   order by id
   limit 1;
 end if;

 if v_site_id is null then
   raise exception 'TENANT_SITE_REQUIRED_FOR_AUDIT' using errcode='P0001';
 end if;

 -- Pass 1: validate every decision before changing any row.
 for d in select * from jsonb_array_elements(coalesce(p_addon_decisions,'[]'::jsonb)) loop
   if jsonb_typeof(d) <> 'object' then
     raise exception 'INVALID_ADDON_DECISION_PAYLOAD' using errcode='P0001';
   end if;

   if not (d ? 'addonRequestId') or nullif(d->>'addonRequestId','') is null then
     raise exception 'ADDON_REQUEST_ID_REQUIRED' using errcode='P0001';
   end if;

   begin
     v_addon_request_id := (d->>'addonRequestId')::bigint;
   exception when invalid_text_representation then
     raise exception 'INVALID_ADDON_REQUEST_ID' using errcode='P0001';
   end;

   if v_addon_request_id = any(v_seen_addon_ids) then
     raise exception 'DUPLICATE_ADDON_DECISION' using errcode='P0001';
   end if;
   v_seen_addon_ids := array_append(v_seen_addon_ids,v_addon_request_id);

   v_decision := d->>'decision';
   if v_decision is null or v_decision not in ('renew','expire') then
     raise exception 'INVALID_ADDON_DECISION' using errcode='P0001';
   end if;

   select * into a
   from public.tenant_addon_requests
   where id=v_addon_request_id
     and tenant_id=s.tenant_id
   for update;

   if not found then
     raise exception 'ADDON_REQUEST_OUT_OF_SCOPE' using errcode='P0001';
   end if;

   if a.status <> 'approved' then
     raise exception 'ADDON_REQUEST_NOT_APPROVED' using errcode='P0001';
   end if;

   if v_decision='renew' then
     if a.ends_at is not null and a.ends_at <= now() then
       raise exception 'EXPIRED_ADDON_RENEWAL_FORBIDDEN' using errcode='P0001';
     end if;

     begin
       v_duration := coalesce(nullif(d->>'durationDays','')::int,a.duration_days,30);
     exception when invalid_text_representation then
       raise exception 'INVALID_ADDON_DURATION' using errcode='P0001';
     end;

     if v_duration<1 or v_duration>3650 then
       raise exception 'INVALID_ADDON_DURATION' using errcode='P0001';
     end if;
   end if;
 end loop;

 -- Pass 2: apply only after the complete decision set has passed validation.
 update public.tenant_subscriptions
 set ends_at=p_new_ends_at,
     status='active',
     renewal_count=renewal_count+1,
     last_renewed_at=now(),
     updated_at=now()
 where id=s.id;

 for d in select * from jsonb_array_elements(coalesce(p_addon_decisions,'[]'::jsonb)) loop
   v_addon_request_id := (d->>'addonRequestId')::bigint;
   v_decision := d->>'decision';

   select * into a
   from public.tenant_addon_requests
   where id=v_addon_request_id
     and tenant_id=s.tenant_id
   for update;

   if v_decision='renew' then
     v_duration := coalesce(nullif(d->>'durationDays','')::int,a.duration_days,30);
     v_new_end := p_new_ends_at+make_interval(days=>v_duration);

     update public.tenant_addon_requests
     set ends_at=v_new_end,duration_days=v_duration
     where id=a.id;

     insert into public.tenant_addon_renewal_decisions(
       tenant_id,subscription_id,addon_request_id,decision,new_duration_days,created_by_user_id
     )
     values(s.tenant_id,s.id,a.id,'renew',v_duration,p_actor_user_id)
     on conflict(subscription_id,addon_request_id)
     do update set
       decision='renew',
       new_duration_days=excluded.new_duration_days,
       created_by_user_id=excluded.created_by_user_id,
       created_at=now();

     v_renewed:=v_renewed+1;
   else
     update public.tenant_addon_requests
     set ends_at=least(coalesce(public.tenant_addon_requests.ends_at,now()),now())
     where public.tenant_addon_requests.id=a.id;

     insert into public.tenant_addon_renewal_decisions(
       tenant_id,subscription_id,addon_request_id,decision,created_by_user_id
     )
     values(s.tenant_id,s.id,a.id,'expire',p_actor_user_id)
     on conflict(subscription_id,addon_request_id)
     do update set
       decision='expire',
       new_duration_days=null,
       created_by_user_id=excluded.created_by_user_id,
       created_at=now();

     v_expired:=v_expired+1;
   end if;
 end loop;

 insert into public.audit_logs(
   tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
 )
 values(
   s.tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,
   'tenant_subscription',s.id::text,'renew_subscription_with_addons',
   jsonb_build_object(
     'newEndsAt',p_new_ends_at,
     'renewedAddons',v_renewed,
     'expiredAddons',v_expired
   )
 );

 return query select true,p_new_ends_at,v_renewed,v_expired;
end;
$$;

revoke all on function public.powerhub_admin_renew_subscription_with_addons(bigint,bigint,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.powerhub_admin_renew_subscription_with_addons(bigint,bigint,timestamptz,jsonb) to service_role;
