-- Apply approved add-ons to effective tenant limits.
-- The package remains unchanged; approved add-ons increase only the selected entitlement.
create or replace function public.powerhub_admin_review_tenant_addon_request(
 p_actor_user_id bigint,p_request_id bigint,p_decision text,p_note text default null
)
returns table(success boolean,status text)
language plpgsql security definer set search_path=public,pg_temp
as $$
declare
 r public.tenant_addon_requests%rowtype;
 v_settings jsonb;
 v_overrides jsonb;
 v_tenant_key text;
 v_effective jsonb;
 v_delta int;
begin
 if p_decision not in ('approved','rejected') then raise exception 'INVALID_DECISION' using errcode='P0001'; end if;
 select * into r from public.tenant_addon_requests where id=p_request_id for update;
 if not found then raise exception 'ADDON_REQUEST_NOT_FOUND' using errcode='P0001'; end if;
 if r.status not in ('pending','reviewing') then raise exception 'ADDON_REQUEST_NOT_PENDING' using errcode='P0001'; end if;

 if p_decision='rejected' then
   update public.tenant_addon_requests set status='rejected',reviewed_at=now(),reviewed_by_user_id=p_actor_user_id,review_note=p_note where id=r.id;
   return query select true,'rejected'; return;
 end if;

 v_delta:=r.quantity * case r.addon_code when 'subscribers50' then 50 else 1 end;

 -- Persist effective entitlement increments in owner_limit_overrides.
 select value into v_settings from public.platform_settings where setting_key='owner_limit_overrides' for update;
 v_overrides:=coalesce(v_settings->'overrides','{}'::jsonb);
 v_tenant_key:=r.tenant_id::text;
 v_effective:=coalesce(v_overrides->v_tenant_key,'{}'::jsonb);

 if r.addon_code='fieldUser' then
   v_effective:=jsonb_set(v_effective,'{fieldUserLimit}',to_jsonb(coalesce((v_effective->>'fieldUserLimit')::int,
      case (select coalesce(ts.package_code,t.package_code) from public.tenants t left join public.tenant_subscriptions ts on ts.tenant_id=t.id where t.id=r.tenant_id)
       when 'basic' then 1 when 'advanced' then 2 when 'professional' then 3 when 'business' then 4 else 4 end)+v_delta),true);
 elsif r.addon_code='platformUser' then
   v_effective:=jsonb_set(v_effective,'{subaccountLimit}',to_jsonb(coalesce((v_effective->>'subaccountLimit')::int,
      case (select coalesce(ts.package_code,t.package_code) from public.tenants t left join public.tenant_subscriptions ts on ts.tenant_id=t.id where t.id=r.tenant_id)
       when 'basic' then 2 when 'advanced' then 2 when 'professional' then 3 when 'business' then 3 else 4 end)+v_delta),true);
 elsif r.addon_code='subscribers50' then
   v_effective:=jsonb_set(v_effective,'{subscriberLimit}',to_jsonb(coalesce((v_effective->>'subscriberLimit')::int,
      case (select coalesce(ts.package_code,t.package_code) from public.tenants t left join public.tenant_subscriptions ts on ts.tenant_id=t.id where t.id=r.tenant_id)
       when 'basic' then 150 when 'advanced' then 300 when 'professional' then 500 when 'business' then 750 else 900 end)+v_delta),true);
 elsif r.addon_code='branch' then
   v_effective:=jsonb_set(v_effective,'{branchLimit}',to_jsonb(coalesce((v_effective->>'branchLimit')::int,
      case (select coalesce(ts.package_code,t.package_code) from public.tenants t left join public.tenant_subscriptions ts on ts.tenant_id=t.id where t.id=r.tenant_id)
       when 'vip' then 2 else 1 end)+v_delta),true);
 end if;

 if r.addon_code<>'sms' then
   insert into public.platform_settings(setting_key,is_enabled,value,message)
   values('owner_limit_overrides',true,jsonb_build_object('overrides',jsonb_set(v_overrides,'{'||v_tenant_key||'}',v_effective,true)),'Effective per-tenant entitlement overrides.')
   on conflict(setting_key) do update set value=excluded.value,is_enabled=true,updated_at=now(),message=excluded.message;
 end if;

 update public.tenant_addon_requests set status='approved',reviewed_at=now(),reviewed_by_user_id=p_actor_user_id,review_note=p_note where id=r.id;
 insert into public.audit_logs(tenant_id,site_id,user_id,entity_type,entity_id,action,after_data)
 values(r.tenant_id,r.site_id,p_actor_user_id,'tenant_addon_request',r.id::text,'approve_addon',
   jsonb_build_object('addonCode',r.addon_code,'quantity',r.quantity,'delta',v_delta));

 return query select true,'approved';
end;
$$;

revoke all on function public.powerhub_admin_review_tenant_addon_request(bigint,bigint,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_review_tenant_addon_request(bigint,bigint,text,text) to service_role;
