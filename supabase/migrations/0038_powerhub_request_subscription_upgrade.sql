create or replace function public.powerhub_request_subscription_upgrade(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_requested_plan text
)
returns table (request_id bigint, requested_plan text, already_requested boolean)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_current_plan text; v_limit_policy jsonb; v_overrides_policy jsonb; v_override jsonb; v_limit_text text; v_override_limit_text text; v_limit integer; v_count integer; v_existing_id bigint; v_existing_plan text; v_role text;
begin
  if p_requested_plan not in ('starter','professional','enterprise') then raise exception 'INVALID_REQUESTED_PLAN' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_tenant_id, hashtext('subscription-upgrade'));
  perform 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id and status <> 'archived' for share;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select plan into v_current_plan from public.tenant_subscriptions where tenant_id=p_tenant_id for share;
  if v_current_plan is null then select plan into v_current_plan from public.tenants where id=p_tenant_id for share; end if;
  if v_current_plan not in ('starter','professional','enterprise') then raise exception 'TENANT_PLAN_NOT_FOUND' using errcode='P0001'; end if;
  if (case p_requested_plan when 'starter' then 1 when 'professional' then 2 else 3 end) <= (case v_current_plan when 'starter' then 1 when 'professional' then 2 else 3 end) then raise exception 'REQUESTED_PLAN_NOT_HIGHER' using errcode='P0001'; end if;
  select value into v_limit_policy from public.platform_settings where setting_key='owner_subscriber_limits';
  select value into v_overrides_policy from public.platform_settings where setting_key='owner_limit_overrides';
  v_override := case when jsonb_typeof(v_overrides_policy->'overrides')='object' then v_overrides_policy->'overrides'->p_tenant_id::text else null end;
  v_limit := case v_current_plan when 'starter' then 100 when 'professional' then 500 else 2000 end;
  v_limit_text := v_limit_policy->'limits'->>v_current_plan;
  if v_limit_text ~ '^\d+$' and v_limit_text::integer between 0 and 100000 then v_limit:=v_limit_text::integer; end if;
  v_override_limit_text := v_override->>'subscriberLimit';
  if v_override_limit_text ~ '^\d+$' and v_override_limit_text::integer between 0 and 100000 then v_limit:=v_override_limit_text::integer; end if;
  select count(*)::integer into v_count from public.subscribers where tenant_id=p_tenant_id;
  if v_count < v_limit then raise exception 'SUBSCRIBER_LIMIT_NOT_REACHED' using errcode='P0001'; end if;
  select id,requested_plan into v_existing_id,v_existing_plan from public.subscription_upgrade_requests where tenant_id=p_tenant_id and status='pending' order by created_at desc limit 1 for share;
  if found then return query select v_existing_id,v_existing_plan,true; return; end if;
  insert into public.subscription_upgrade_requests(tenant_id,requested_by_user_id,current_plan,requested_plan,reason,status) values(p_tenant_id,p_user_id,v_current_plan,p_requested_plan,'subscriber_limit_reached','pending') returning id into v_existing_id;
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,p_site_id,p_user_id,v_role,'subscription_upgrade_request',v_existing_id::text,'request_upgrade',jsonb_build_object('currentPlan',v_current_plan,'requestedPlan',p_requested_plan,'reason','subscriber_limit_reached','subscriberCount',v_count,'subscriberLimit',v_limit));
  return query select v_existing_id,p_requested_plan,false;
end;
$$;
revoke execute on function public.powerhub_request_subscription_upgrade(bigint,bigint,bigint,text) from public, anon, authenticated;
grant execute on function public.powerhub_request_subscription_upgrade(bigint,bigint,bigint,text) to service_role;
