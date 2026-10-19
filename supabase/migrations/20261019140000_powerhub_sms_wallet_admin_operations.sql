-- Admin-only SMS wallet operations. All credits are created pending and require a second, explicit confirmation.
create or replace function public.powerhub_admin_create_sms_recharge_request(
 p_actor_user_id bigint,p_tenant_id bigint,p_messages integer,p_note text,p_idempotency_key uuid
)
returns table(ledger_id bigint,tenant_id bigint,status text)
language plpgsql security definer set search_path=public,pg_temp
as $function$
declare v_role text;v_row public.tenant_sms_recharge_ledger%rowtype;v_site_id bigint;
begin
 select u.platform_role into v_role from public.users u where u.id=p_actor_user_id and u.role='admin'
  and u.account_status='active' and u.platform_role in('platform_owner','platform_admin','finance_admin');
 if v_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
 if p_tenant_id is null or p_messages is null or p_messages<1 or p_messages>100000000 or p_idempotency_key is null then
  raise exception 'INVALID_SMS_RECHARGE_REQUEST' using errcode='22023'; end if;
 perform 1 from public.tenants t where t.id=p_tenant_id for update;
 if not found then raise exception 'TENANT_NOT_FOUND' using errcode='P0002'; end if;
 select * into v_row from public.tenant_sms_recharge_ledger l where l.idempotency_key=p_idempotency_key for update;
 if found then
  if v_row.tenant_id<>p_tenant_id or v_row.requested_messages<>p_messages or v_row.status<>'pending' then
   raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='23505'; end if;
  return query select v_row.id,v_row.tenant_id,v_row.status; return;
 end if;
 select s.id into v_site_id from public.sites s where s.tenant_id=p_tenant_id and s.status<>'archived' order by s.id limit 1;
 insert into public.tenant_sms_recharge_ledger(tenant_id,request_id,provider_mode,status,requested_messages,credited_messages,
  idempotency_key,requested_by_user_id,note)
 values(p_tenant_id,null,'manual','pending',p_messages,0,p_idempotency_key,p_actor_user_id,nullif(trim(coalesce(p_note,'')),'')) returning * into v_row;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data,metadata)
 values(p_tenant_id,v_site_id,p_actor_user_id,v_role,'tenant_sms_recharge_ledger',v_row.id::text,'sms_wallet_credit_requested',
  jsonb_build_object('requestedMessages',p_messages,'status','pending'),jsonb_build_object('note',nullif(trim(coalesce(p_note,'')),'')));
 return query select v_row.id,v_row.tenant_id,v_row.status;
end;
$function$;
revoke all on function public.powerhub_admin_create_sms_recharge_request(bigint,bigint,integer,text,uuid) from public,anon,authenticated;
grant execute on function public.powerhub_admin_create_sms_recharge_request(bigint,bigint,integer,text,uuid) to service_role;

create or replace function public.powerhub_admin_create_sms_credit_package(
 p_actor_user_id bigint,p_code text,p_name text,p_description text,p_messages integer,p_price numeric,p_currency text,p_is_active boolean
)
returns table(id bigint,name text)
language plpgsql security definer set search_path=public,pg_temp
as $function$
declare v_role text;v_row public.platform_sms_plans%rowtype;
begin
 select u.platform_role into v_role from public.users u where u.id=p_actor_user_id and u.role='admin'
  and u.account_status='active' and u.platform_role in('platform_owner','platform_admin');
 if v_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
 if p_code is null or trim(p_code)='' or p_name is null or trim(p_name)='' or p_messages<1 or p_messages>100000000
  or p_price<0 or length(p_currency)<>3 then raise exception 'INVALID_SMS_PACKAGE' using errcode='22023'; end if;
 if exists(select 1 from public.platform_sms_plans p where lower(p.code)=lower(trim(p_code))) then
  raise exception 'DUPLICATE_CODE' using errcode='23505'; end if;
 insert into public.platform_sms_plans(code,name,description,included_messages,price_amount,currency,is_active,created_at,updated_at)
 values(lower(trim(p_code)),trim(p_name),nullif(trim(coalesce(p_description,'')),''),p_messages,p_price,upper(p_currency),coalesce(p_is_active,true),now(),now())
 returning * into v_row;
 insert into public.audit_logs(user_id,actor_platform_role,entity_type,entity_id,action,after_data)
 values(p_actor_user_id,v_role,'platform_sms_plan',v_row.id::text,'sms_credit_package_created',
  jsonb_build_object('code',v_row.code,'messages',v_row.included_messages,'price',v_row.price_amount,'currency',v_row.currency,'active',v_row.is_active));
 return query select v_row.id,v_row.name;
end;
$function$;
revoke all on function public.powerhub_admin_create_sms_credit_package(bigint,text,text,text,integer,numeric,text,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_admin_create_sms_credit_package(bigint,text,text,text,integer,numeric,text,boolean) to service_role;

create or replace function public.powerhub_admin_update_sms_credit_package(
 p_actor_user_id bigint,p_id bigint,p_name text default null,p_description text default null,p_messages integer default null,
 p_price numeric default null,p_currency text default null,p_is_active boolean default null
)
returns table(id bigint,is_active boolean)
language plpgsql security definer set search_path=public,pg_temp
as $function$
declare v_role text;v_row public.platform_sms_plans%rowtype;
begin
 select u.platform_role into v_role from public.users u where u.id=p_actor_user_id and u.role='admin'
  and u.account_status='active' and u.platform_role in('platform_owner','platform_admin');
 if v_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
 if p_messages is not null and (p_messages<1 or p_messages>100000000) then raise exception 'INVALID_SMS_PACKAGE_QUANTITY' using errcode='22023'; end if;
 if p_price is not null and p_price<0 then raise exception 'INVALID_SMS_PACKAGE_PRICE' using errcode='22023'; end if;
 update public.platform_sms_plans set name=coalesce(nullif(trim(p_name),''),name),
  description=case when p_description is null then description else nullif(trim(p_description),'') end,
  included_messages=coalesce(p_messages,included_messages),price_amount=coalesce(p_price,price_amount),
  currency=coalesce(upper(p_currency),currency),is_active=coalesce(p_is_active,is_active),updated_at=now()
 where platform_sms_plans.id=p_id returning * into v_row;
 if not found then return; end if;
 insert into public.audit_logs(user_id,actor_platform_role,entity_type,entity_id,action,after_data)
 values(p_actor_user_id,v_role,'platform_sms_plan',v_row.id::text,'sms_credit_package_updated',
  jsonb_build_object('messages',v_row.included_messages,'price',v_row.price_amount,'currency',v_row.currency,'active',v_row.is_active));
 return query select v_row.id,v_row.is_active;
end;
$function$;
revoke all on function public.powerhub_admin_update_sms_credit_package(bigint,bigint,text,text,integer,numeric,text,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_admin_update_sms_credit_package(bigint,bigint,text,text,integer,numeric,text,boolean) to service_role;
