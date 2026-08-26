create or replace function public.powerhub_update_company_account_phone(p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_account_id bigint,p_phone_number text)
returns table (account_id bigint) language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_account public.company_accounts%rowtype; v_role text;
begin
  if p_phone_number !~ '^\\+?[0-9]{7,20}$' then raise exception 'INVALID_ACCOUNT_PHONE' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_account_id); select * into v_account from public.company_accounts where id=p_account_id and tenant_id=p_tenant_id for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if exists(select 1 from public.company_account_sites where account_id=p_account_id) and not exists(select 1 from public.company_account_sites where account_id=p_account_id and site_id=p_site_id and tenant_id=p_tenant_id) then raise exception 'ACCOUNT_SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if exists(select 1 from public.company_accounts where tenant_id=p_tenant_id and account_type=v_account.account_type and phone_number=p_phone_number and id<>p_account_id) then raise exception 'ACCOUNT_PHONE_CONFLICT' using errcode='P0001'; end if;
  update public.company_accounts set phone_number=p_phone_number,updated_at=now() where id=p_account_id;
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_user_id,v_role,'company_account',p_account_id::text,'update_phone',jsonb_build_object('phoneNumber',v_account.phone_number),jsonb_build_object('phoneNumber',p_phone_number));
  return query select p_account_id;
end; $$;

create or replace function public.powerhub_update_company_account_opening_balance(p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_account_id bigint,p_opening_balance numeric)
returns table (account_id bigint) language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_account public.company_accounts%rowtype; v_role text;
begin
  if p_opening_balance < 0 then raise exception 'INVALID_OPENING_BALANCE' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_account_id); select * into v_account from public.company_accounts where id=p_account_id and tenant_id=p_tenant_id for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if exists(select 1 from public.company_account_sites where account_id=p_account_id) and not exists(select 1 from public.company_account_sites where account_id=p_account_id and site_id=p_site_id and tenant_id=p_tenant_id) then raise exception 'ACCOUNT_SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if exists(select 1 from public.account_transactions where tenant_id=p_tenant_id and account_id=p_account_id) then raise exception 'OPENING_BALANCE_HAS_MOVEMENTS' using errcode='P0001'; end if;
  update public.company_accounts set opening_balance=p_opening_balance,updated_at=now() where id=p_account_id;
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_user_id,v_role,'company_account',p_account_id::text,'update_opening_balance',jsonb_build_object('openingBalance',v_account.opening_balance),jsonb_build_object('openingBalance',p_opening_balance));
  return query select p_account_id;
end; $$;

create or replace function public.powerhub_update_company_account_sites(p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_account_id bigint,p_site_ids bigint[])
returns table (account_id bigint) language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_role text;
begin
  if coalesce(cardinality(p_site_ids),0)=0 then raise exception 'ACCOUNT_SITES_REQUIRED' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_account_id);
  if not exists(select 1 from public.company_accounts where id=p_account_id and tenant_id=p_tenant_id for update) then raise exception 'ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if (select count(*) from public.sites where tenant_id=p_tenant_id and id=any(p_site_ids))<>cardinality(p_site_ids) then raise exception 'ACCOUNT_SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  delete from public.company_account_sites where tenant_id=p_tenant_id and account_id=p_account_id;
  insert into public.company_account_sites(tenant_id,account_id,site_id) select p_tenant_id,p_account_id,site_id from unnest(p_site_ids) as site_id;
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,p_site_id,p_user_id,v_role,'company_account',p_account_id::text,'update_sites',jsonb_build_object('siteIds',p_site_ids));
  return query select p_account_id;
end; $$;

revoke execute on function public.powerhub_update_company_account_phone(bigint,bigint,bigint,bigint,text),public.powerhub_update_company_account_opening_balance(bigint,bigint,bigint,bigint,numeric),public.powerhub_update_company_account_sites(bigint,bigint,bigint,bigint,bigint[]) from public,anon,authenticated;
grant execute on function public.powerhub_update_company_account_phone(bigint,bigint,bigint,bigint,text),public.powerhub_update_company_account_opening_balance(bigint,bigint,bigint,bigint,numeric),public.powerhub_update_company_account_sites(bigint,bigint,bigint,bigint,bigint[]) to service_role;
