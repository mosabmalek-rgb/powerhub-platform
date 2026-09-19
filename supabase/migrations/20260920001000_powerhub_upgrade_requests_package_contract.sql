create or replace function public.powerhub_request_subscription_upgrade(
 p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_requested_plan text)
returns table(request_id bigint,requested_plan text,already_requested boolean)
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_current_plan text; v_current_package text; v_requested_package text; v_catalog jsonb; v_overrides jsonb; v_override jsonb; v_limit integer; v_count integer; v_existing_id bigint; v_existing_plan text; v_role text;
 v_order int; v_current_order int;
begin
 if p_requested_plan not in ('basic','advanced','professional','business','vip','starter','enterprise') then raise exception 'INVALID_REQUESTED_PLAN' using errcode='P0001'; end if;
 p_requested_plan:=case p_requested_plan when 'starter' then 'basic' when 'enterprise' then 'business' when 'professional' then 'advanced' else p_requested_plan end;
 perform pg_advisory_xact_lock(p_tenant_id,hashtext('subscription-upgrade'));
 perform 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id and status<>'archived' for share;
 if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
 select coalesce(nullif(lower(btrim(ts.package_code)),''),case ts.plan when 'starter' then 'basic' when 'professional' then 'advanced' when 'enterprise' then 'business' end),ts.plan into v_current_package,v_current_plan
 from public.tenant_subscriptions ts where ts.tenant_id=p_tenant_id order by ts.created_at desc,ts.id desc limit 1 for share;
 if v_current_package is null then select case plan when 'starter' then 'basic' when 'professional' then 'advanced' when 'enterprise' then 'business' end,plan into v_current_package,v_current_plan from public.tenants where id=p_tenant_id for share; end if;
 if v_current_package is null then raise exception 'TENANT_PLAN_NOT_FOUND' using errcode='P0001'; end if;
 v_current_order:=case v_current_package when 'basic' then 1 when 'advanced' then 2 when 'professional' then 3 when 'business' then 4 when 'vip' then 5 else 0 end;
 v_order:=case p_requested_plan when 'basic' then 1 when 'advanced' then 2 when 'professional' then 3 when 'business' then 4 when 'vip' then 5 else 0 end;
 if v_order<=v_current_order then raise exception 'REQUESTED_PLAN_NOT_HIGHER' using errcode='P0001'; end if;
 select value into v_catalog from public.platform_settings where setting_key='subscription_package_catalog' and is_enabled=true;
 select coalesce((pkg->'features'->'subscribers'->>'limit')::integer,(pkg->>'includedSubscribers')::integer,0) into v_limit
 from jsonb_array_elements(coalesce(v_catalog->'packages','[]'::jsonb)) pkg where pkg->>'code'=v_current_package and coalesce((pkg->>'active')::boolean,true)=true limit 1;
 select value into v_overrides from public.platform_settings where setting_key='owner_limit_overrides';
 v_override:=case when jsonb_typeof(v_overrides->'overrides')='object' then v_overrides->'overrides'->p_tenant_id::text else null end;
 if jsonb_typeof(v_override)='object' and (v_override->>'subscriberLimit') ~ '^\d+$' then v_limit:=least((v_override->>'subscriberLimit')::integer,100000); end if;
 select count(*)::integer into v_count from public.subscribers where tenant_id=p_tenant_id;
 if v_count<v_limit then raise exception 'SUBSCRIBER_LIMIT_NOT_REACHED' using errcode='P0001'; end if;
 select id,requested_plan into v_existing_id,v_existing_plan from public.subscription_upgrade_requests where tenant_id=p_tenant_id and status in ('pending','reviewing') order by created_at desc limit 1 for share;
 if found then return query select v_existing_id,v_existing_plan,true; return; end if;
 insert into public.subscription_upgrade_requests(tenant_id,requested_by_user_id,current_plan,requested_plan,reason,status) values(p_tenant_id,p_user_id,v_current_plan,p_requested_plan,'subscriber_limit_reached','pending') returning id into v_existing_id;
 select platform_role into v_role from public.users where id=p_user_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,p_site_id,p_user_id,v_role,'subscription_upgrade_request',v_existing_id::text,'request_upgrade',jsonb_build_object('currentPlan',v_current_plan,'requestedPlan',p_requested_plan,'currentPackage',v_current_package,'subscriberCount',v_count,'subscriberLimit',v_limit));
 return query select v_existing_id,p_requested_plan,false;
end;$$;