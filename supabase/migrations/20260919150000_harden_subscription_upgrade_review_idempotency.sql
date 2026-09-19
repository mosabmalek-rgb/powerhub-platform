-- Harden subscription mutation retries with operation identity.
alter table public.offline_sync_operations drop constraint if exists offline_sync_operations_operation_type_check;
alter table public.offline_sync_operations add constraint offline_sync_operations_operation_type_check check (
 operation_type = any(array[
 'subscriber_create','subscriber_update','generator_create','generator_update','invoice_issue','payment_create',
 'account_movement_create','account_transfer_create','expense_create','employee_create','site_create','collector_session_open',
 'tariff_create','company_account_create','staff_create','subscription_renew','subscription_update'
 ]::text[])
);

create or replace function public.powerhub_admin_renew_subscription_idempotent(
 p_actor_user_id bigint,p_tenant_id bigint,p_periods integer,p_client_operation_id text
)
returns table(success boolean,ends_at timestamptz,replayed boolean)
language plpgsql security definer set search_path=public,pg_temp
as $function$
declare v_role text;v_sub public.tenant_subscriptions%rowtype;v_site_id bigint;v_base timestamptz;v_period interval;v_ends_at timestamptz;v_op public.offline_sync_operations%rowtype;
begin
 if nullif(trim(p_client_operation_id),'') is null then raise exception 'CLIENT_OPERATION_REQUIRED' using errcode='P0001'; end if;
 select platform_role into v_role from public.users where id=p_actor_user_id and role='admin' and account_status='active' and platform_role in('platform_owner','platform_admin');
 if v_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
 if p_periods<1 or p_periods>24 then raise exception 'INVALID_PERIODS' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtext('subscription-renew:'||p_actor_user_id::text||':'||trim(p_client_operation_id))::bigint);
 select * into v_op from public.offline_sync_operations where user_id=p_actor_user_id and client_operation_id=trim(p_client_operation_id) for update;
 if found then
   if v_op.operation_type<>'subscription_renew' or v_op.tenant_id<>p_tenant_id or v_op.response->>'periods'<>(p_periods::text) then raise exception 'SUBSCRIPTION_RENEW_OPERATION_CONFLICT' using errcode='P0001'; end if;
   return query select true,(v_op.response->>'endsAt')::timestamptz,true; return;
 end if;
 select * into v_sub from public.tenant_subscriptions where tenant_id=p_tenant_id for update;
 if not found then raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode='P0002'; end if;
 select s.id into v_site_id from public.sites s where s.tenant_id=p_tenant_id order by s.id limit 1;
 if v_site_id is null then raise exception 'SITE_NOT_FOUND' using errcode='P0002'; end if;
 v_base:=greatest(v_sub.ends_at,now());
 v_period:=case v_sub.billing_cycle when 'monthly' then make_interval(months=>p_periods) when 'yearly' then make_interval(years=>p_periods) else null end;
 if v_period is null then raise exception 'INVALID_BILLING_CYCLE' using errcode='22023'; end if;
 v_ends_at:=v_base+v_period;
 update public.tenant_subscriptions set status='active',ends_at=v_ends_at,renewal_count=renewal_count+p_periods,last_renewed_at=now(),updated_at=now() where id=v_sub.id;
 update public.tenants set status='active',updated_at=now() where id=p_tenant_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,v_site_id,p_actor_user_id,v_role,'tenant_subscription',v_sub.id::text,'platform_admin_renew_subscription',jsonb_build_object('periods',p_periods,'billingCycle',v_sub.billing_cycle,'previousEndsAt',v_sub.ends_at,'endsAt',v_ends_at));
 insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response) values(p_tenant_id,v_site_id,p_actor_user_id,trim(p_client_operation_id),'subscription_renew','tenant_subscription',v_sub.id,jsonb_build_object('periods',p_periods,'endsAt',v_ends_at));
 return query select true,v_ends_at,false;
end;
$function$;

create or replace function public.powerhub_admin_update_subscription_idempotent(
 p_actor_user_id bigint,p_tenant_id bigint,p_plan text,p_status text,p_billing_cycle text,p_ends_at timestamptz,p_auto_renew boolean,p_notes text,p_sms_plan_id bigint,p_client_operation_id text
)
returns table(success boolean,subscription_id bigint,site_id bigint,replayed boolean)
language plpgsql security definer set search_path=public,pg_temp
as $function$
declare v_role text;v_sub public.tenant_subscriptions%rowtype;v_site_id bigint;v_sms_active boolean;v_op public.offline_sync_operations%rowtype;
begin
 if nullif(trim(p_client_operation_id),'') is null then raise exception 'CLIENT_OPERATION_REQUIRED' using errcode='P0001'; end if;
 select platform_role into v_role from public.users where id=p_actor_user_id and role='admin' and account_status='active' and platform_role in('platform_owner','platform_admin','finance_admin');
 if v_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
 if p_plan not in('starter','professional','enterprise') then raise exception 'INVALID_SUBSCRIPTION_PLAN' using errcode='22023'; end if;
 if p_status not in('trial','active','overdue','suspended','cancelled') then raise exception 'INVALID_SUBSCRIPTION_STATUS' using errcode='22023'; end if;
 if p_billing_cycle not in('monthly','yearly') then raise exception 'INVALID_BILLING_CYCLE' using errcode='22023'; end if;
 if p_sms_plan_id is not null then select is_active into v_sms_active from public.platform_sms_plans where id=p_sms_plan_id; if coalesce(v_sms_active,false)=false then raise exception 'SMS_PLAN_NOT_ACTIVE' using errcode='22023'; end if; end if;
 perform pg_advisory_xact_lock(hashtext('subscription-update:'||p_actor_user_id::text||':'||trim(p_client_operation_id))::bigint);
 select * into v_op from public.offline_sync_operations where user_id=p_actor_user_id and client_operation_id=trim(p_client_operation_id) for update;
 if found then
   if v_op.operation_type<>'subscription_update' or v_op.tenant_id<>p_tenant_id or v_op.response->>'plan'<>p_plan or v_op.response->>'status'<>p_status or v_op.response->>'billingCycle'<>p_billing_cycle or (v_op.response->>'endsAt')::timestamptz is distinct from p_ends_at or (v_op.response->>'autoRenew')::boolean is distinct from p_auto_renew or coalesce(v_op.response->>'notes','')<>coalesce(p_notes,'') or (v_op.response->>'smsPlanId')::bigint is distinct from p_sms_plan_id then raise exception 'SUBSCRIPTION_UPDATE_OPERATION_CONFLICT' using errcode='P0001'; end if;
   return query select true,(v_op.response->>'subscriptionId')::bigint,v_op.site_id,true; return;
 end if;
 select * into v_sub from public.tenant_subscriptions where tenant_id=p_tenant_id for update;
 if not found then raise exception 'SUBSCRIPTION_OR_SITE_NOT_FOUND' using errcode='P0002'; end if;
 select s.id into v_site_id from public.sites s where s.tenant_id=p_tenant_id order by s.id limit 1;
 if v_site_id is null then raise exception 'SUBSCRIPTION_OR_SITE_NOT_FOUND' using errcode='P0002'; end if;
 update public.tenant_subscriptions set plan=p_plan,status=p_status,billing_cycle=p_billing_cycle,ends_at=p_ends_at,auto_renew=p_auto_renew,notes=p_notes,sms_plan_id=p_sms_plan_id,updated_at=now() where id=v_sub.id;
 update public.tenants set plan=p_plan,status=case when p_status in('suspended','cancelled') then 'suspended' else 'active' end,updated_at=now() where id=p_tenant_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,v_site_id,p_actor_user_id,v_role,'tenant_subscription',v_sub.id::text,'platform_admin_update_subscription',jsonb_build_object('plan',p_plan,'status',p_status,'billingCycle',p_billing_cycle,'endsAt',p_ends_at,'autoRenew',p_auto_renew,'smsPlanId',p_sms_plan_id));
 insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response) values(p_tenant_id,v_site_id,p_actor_user_id,trim(p_client_operation_id),'subscription_update','tenant_subscription',v_sub.id,jsonb_build_object('subscriptionId',v_sub.id,'plan',p_plan,'status',p_status,'billingCycle',p_billing_cycle,'endsAt',p_ends_at,'autoRenew',p_auto_renew,'notes',coalesce(p_notes,''),'smsPlanId',p_sms_plan_id));
 return query select true,v_sub.id,v_site_id,false;
end;
$function$;

revoke execute on function public.powerhub_admin_renew_subscription_idempotent(bigint,bigint,integer,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_renew_subscription_idempotent(bigint,bigint,integer,text) to service_role;
revoke execute on function public.powerhub_admin_update_subscription_idempotent(bigint,bigint,text,text,text,timestamptz,boolean,text,bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_update_subscription_idempotent(bigint,bigint,text,text,text,timestamptz,boolean,text,bigint,text) to service_role;


create or replace function public.powerhub_admin_quick_upgrade_owner_plan_idempotent(
  p_actor_user_id bigint,p_tenant_id bigint,p_plan text,p_note text,p_client_operation_id text
)
returns table(success boolean,plan text,replayed boolean)
language plpgsql security definer set search_path=public,pg_temp
as $function$
declare
 v_actor_platform_role text;v_tenant public.tenants%rowtype;v_subscription public.tenant_subscriptions%rowtype;
 v_site_id bigint;v_current_rank integer;v_requested_rank integer;v_op public.offline_sync_operations%rowtype;
begin
 if nullif(trim(p_client_operation_id),'') is null then raise exception 'CLIENT_OPERATION_REQUIRED' using errcode='P0001'; end if;
 select u.platform_role into v_actor_platform_role from public.users u where u.id=p_actor_user_id and u.role='admin' and u.account_status='active' and u.platform_role in('platform_owner','platform_admin');
 if v_actor_platform_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
 if p_plan not in('starter','professional','enterprise') then raise exception 'INVALID_PLAN' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtext('subscription-quick-upgrade:'||p_actor_user_id::text||':'||trim(p_client_operation_id))::bigint);
 select * into v_op from public.offline_sync_operations where user_id=p_actor_user_id and client_operation_id=trim(p_client_operation_id) for update;
 if found then
   if v_op.operation_type<>'subscription_quick_upgrade' or v_op.tenant_id<>p_tenant_id or v_op.response->>'plan'<>p_plan or coalesce(v_op.response->>'note','')<>coalesce(p_note,'') then raise exception 'SUBSCRIPTION_QUICK_UPGRADE_OPERATION_CONFLICT' using errcode='P0001'; end if;
   return query select true,p_plan,true; return;
 end if;
 select * into v_tenant from public.tenants t where t.id=p_tenant_id for update;
 if not found then raise exception 'TENANT_NOT_FOUND' using errcode='P0002'; end if;
 select * into v_subscription from public.tenant_subscriptions ts where ts.tenant_id=p_tenant_id order by created_at desc,id desc limit 1 for update;
 if not found then raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode='P0002'; end if;
 if v_tenant.plan is distinct from v_subscription.plan then raise exception 'SUBSCRIPTION_PLAN_DRIFT' using errcode='P0001'; end if;
 select s.id into v_site_id from public.sites s where s.tenant_id=p_tenant_id order by s.id limit 1;
 if v_site_id is null then raise exception 'SITE_NOT_FOUND' using errcode='P0002'; end if;
 v_current_rank:=case v_tenant.plan when 'starter' then 1 when 'professional' then 2 when 'enterprise' then 3 end;
 v_requested_rank:=case p_plan when 'starter' then 1 when 'professional' then 2 when 'enterprise' then 3 end;
 if p_plan=v_tenant.plan then
   insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response)
   values(p_tenant_id,v_site_id,p_actor_user_id,trim(p_client_operation_id),'subscription_quick_upgrade','tenant_subscription',v_subscription.id,jsonb_build_object('plan',p_plan,'note',coalesce(p_note,'')));
   return query select true,p_plan,false; return;
 end if;
 if v_requested_rank<=v_current_rank then raise exception 'PLAN_NOT_UPGRADE' using errcode='22023'; end if;
 update public.tenants set plan=p_plan,updated_at=now() where id=p_tenant_id;
 update public.tenant_subscriptions set plan=p_plan,updated_at=now() where id=v_subscription.id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
 values(p_tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,'tenant_subscription',v_subscription.id::text,'platform_admin_quick_upgrade_owner_plan',jsonb_build_object('fromPlan',v_tenant.plan,'toPlan',p_plan,'note',p_note));
 insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response)
 values(p_tenant_id,v_site_id,p_actor_user_id,trim(p_client_operation_id),'subscription_quick_upgrade','tenant_subscription',v_subscription.id,jsonb_build_object('plan',p_plan,'note',coalesce(p_note,'')));
 return query select true,p_plan,false;
end;
$function$;

revoke execute on function public.powerhub_admin_quick_upgrade_owner_plan_idempotent(bigint,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_quick_upgrade_owner_plan_idempotent(bigint,bigint,text,text,text) to service_role;
