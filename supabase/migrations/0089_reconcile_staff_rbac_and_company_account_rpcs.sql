-- Staging/runtime reconciliation for Supabase-first PowerHub paths.
-- This migration is intentionally idempotent and does not alter table data.

create or replace function public.powerhub_create_company_account(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_name text, p_account_type text,
  p_phone_number text, p_opening_balance numeric, p_color text, p_site_ids bigint[]
)
returns table (account_id bigint)
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare v_account_id bigint; v_platform_role text;
begin
  if coalesce(array_length(p_site_ids, 1), 0) = 0 then raise exception 'ACCOUNT_SITES_REQUIRED' using errcode='P0001'; end if;
  if p_opening_balance < 0 then raise exception 'INVALID_OPENING_BALANCE' using errcode='P0001'; end if;
  if p_account_type not in ('cash','jawwal_pay','palpay','bank_of_palestine','other') then raise exception 'INVALID_ACCOUNT_TYPE' using errcode='P0001'; end if;
  if (select count(*) from public.sites where tenant_id=p_tenant_id and id=any(p_site_ids)) <> cardinality(p_site_ids) then raise exception 'ACCOUNT_SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  insert into public.company_accounts(tenant_id,name,account_type,phone_number,opening_balance,color)
  values(p_tenant_id,p_name,p_account_type,p_phone_number,p_opening_balance,coalesce(p_color,'#64748b')) returning id into v_account_id;
  insert into public.company_account_sites(tenant_id,account_id,site_id)
  select p_tenant_id,v_account_id,site_id from unnest(p_site_ids) as site_id;
  select platform_role into v_platform_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
  values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'company_account',v_account_id::text,'create',jsonb_build_object('name',p_name,'accountType',p_account_type,'siteIds',p_site_ids,'openingBalance',p_opening_balance));
  return query select v_account_id;
end; $$;

create or replace function public.powerhub_add_account_movement(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_account_id bigint,p_transaction_type text,
  p_amount numeric,p_description text,p_reference_no text
)
returns table (transaction_id bigint)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_account public.company_accounts%rowtype; v_balance numeric(14,2); v_transaction_id bigint; v_platform_role text;
begin
  if p_transaction_type not in ('deposit','withdrawal') or p_amount <= 0 then raise exception 'INVALID_ACCOUNT_MOVEMENT' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_account_id);
  select * into v_account from public.company_accounts where id=p_account_id and tenant_id=p_tenant_id for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if exists(select 1 from public.company_account_sites where account_id=p_account_id) and not exists(select 1 from public.company_account_sites where account_id=p_account_id and tenant_id=p_tenant_id and site_id=p_site_id) then raise exception 'ACCOUNT_SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if exists(select 1 from public.financial_settlements where tenant_id=p_tenant_id and site_id=p_site_id and status='locked' and period_start<=now() and period_end>=now()) then raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001'; end if;
  select v_account.opening_balance + coalesce(sum(case when transaction_type in ('deposit','transfer_in','collection') then amount else -amount end),0) into v_balance from public.account_transactions where tenant_id=p_tenant_id and account_id=p_account_id;
  if p_transaction_type='withdrawal' and p_amount>v_balance then raise exception 'INSUFFICIENT_ACCOUNT_BALANCE' using errcode='P0001'; end if;
  insert into public.account_transactions(tenant_id,account_id,transaction_type,amount,description,reference_no,created_by_user_id)
  values(p_tenant_id,p_account_id,p_transaction_type,p_amount,p_description,p_reference_no,p_user_id) returning id into v_transaction_id;
  select platform_role into v_platform_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
  values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'company_account',p_account_id::text,p_transaction_type,jsonb_build_object('transactionId',v_transaction_id,'amount',p_amount,'referenceNo',p_reference_no));
  return query select v_transaction_id;
end; $$;

create or replace function public.powerhub_transfer_company_accounts(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_from_account_id bigint,p_to_account_id bigint,p_amount numeric,p_description text
)
returns table (from_transaction_id bigint,to_transaction_id bigint)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_source public.company_accounts%rowtype; v_destination public.company_accounts%rowtype; v_balance numeric(14,2); v_from_transaction_id bigint; v_to_transaction_id bigint; v_platform_role text;
begin
  if p_from_account_id=p_to_account_id then raise exception 'SAME_TRANSFER_ACCOUNT' using errcode='P0001'; end if;
  if p_amount<=0 then raise exception 'INVALID_TRANSFER_AMOUNT' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(least(p_from_account_id,p_to_account_id));
  perform pg_advisory_xact_lock(greatest(p_from_account_id,p_to_account_id));
  select * into v_source from public.company_accounts where id=p_from_account_id and tenant_id=p_tenant_id for update;
  select * into v_destination from public.company_accounts where id=p_to_account_id and tenant_id=p_tenant_id for update;
  if v_source.id is null or v_destination.id is null then raise exception 'ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if exists(select 1 from public.financial_settlements where tenant_id=p_tenant_id and site_id=p_site_id and status='locked' and period_start<=now() and period_end>=now()) then raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001'; end if;
  select v_source.opening_balance + coalesce(sum(case when transaction_type in ('deposit','transfer_in','collection') then amount else -amount end),0) into v_balance from public.account_transactions where tenant_id=p_tenant_id and account_id=p_from_account_id;
  if p_amount>v_balance then raise exception 'INSUFFICIENT_ACCOUNT_BALANCE' using errcode='P0001'; end if;
  insert into public.account_transactions(tenant_id,account_id,related_account_id,transaction_type,amount,description,created_by_user_id)
  values(p_tenant_id,p_from_account_id,p_to_account_id,'transfer_out',p_amount,p_description,p_user_id) returning id into v_from_transaction_id;
  insert into public.account_transactions(tenant_id,account_id,related_account_id,transaction_type,amount,description,created_by_user_id)
  values(p_tenant_id,p_to_account_id,p_from_account_id,'transfer_in',p_amount,p_description,p_user_id) returning id into v_to_transaction_id;
  select platform_role into v_platform_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
  values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'company_account',p_from_account_id::text,'transfer',jsonb_build_object('toAccountId',p_to_account_id,'amount',p_amount,'fromTransactionId',v_from_transaction_id,'toTransactionId',v_to_transaction_id));
  return query select v_from_transaction_id,v_to_transaction_id;
end; $$;

create or replace function public.powerhub_update_company_account_phone(p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_account_id bigint,p_phone_number text)
returns table(account_id bigint) language plpgsql security invoker set search_path=public,pg_temp as $$
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
returns table(account_id bigint) language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_account public.company_accounts%rowtype; v_role text;
begin
  if p_opening_balance<0 then raise exception 'INVALID_OPENING_BALANCE' using errcode='P0001'; end if;
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
returns table(account_id bigint) language plpgsql security invoker set search_path=public,pg_temp as $$
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

create or replace function public.powerhub_save_custom_permission_role(p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_role_id bigint,p_name text,p_description text,p_permissions jsonb)
returns table(role_id bigint,mutation text) language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_before jsonb; v_role_id bigint; v_actor_role text; v_actor_platform_role text; v_actor_tenant_role text;
begin
  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role<>'admin' then select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_user_id and is_active=true and membership_status='active'; if v_actor_tenant_role<>'owner' then raise exception 'ROLE_MANAGEMENT_FORBIDDEN' using errcode='P0001'; end if; else v_actor_tenant_role:='platform_admin'; end if;
  if p_name is null or char_length(btrim(p_name))<2 or char_length(btrim(p_name))>120 or p_permissions is null or jsonb_typeof(p_permissions)<>'array' or jsonb_array_length(p_permissions)<1 then raise exception 'INVALID_CUSTOM_ROLE_INPUT' using errcode='P0001'; end if;
  if exists(select 1 from jsonb_array_elements_text(p_permissions) capability(value) where capability.value not in ('manageSubscribers','manageGenerators','recordReadings','accessFieldApp','approveReadings','manageTariffs','issueInvoices','collectPayments','manageExpenses','managePayroll','manageTeam','manageMessaging','viewAudit')) then raise exception 'INVALID_CUSTOM_ROLE_CAPABILITY' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_tenant_id,hashtext('custom-permission-role'));
  if p_role_id is null then
    insert into public.custom_permission_roles(tenant_id,name,description,permissions,is_active,created_by_user_id) values(p_tenant_id,btrim(p_name),nullif(btrim(coalesce(p_description,'')),''),p_permissions,true,p_user_id) returning id into v_role_id;
    insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,after_data) values(p_tenant_id,p_site_id,p_user_id,v_actor_platform_role,v_actor_tenant_role,'custom_permission_role',v_role_id::text,'create',jsonb_build_object('name',btrim(p_name),'description',nullif(btrim(coalesce(p_description,'')),''),'permissions',p_permissions,'isActive',true));
    return query select v_role_id,'create'::text;
  end if;
  select to_jsonb(role) into v_before from public.custom_permission_roles role where role.id=p_role_id and role.tenant_id=p_tenant_id for update;
  if not found then raise exception 'CUSTOM_ROLE_NOT_FOUND' using errcode='P0001'; end if;
  update public.custom_permission_roles set name=btrim(p_name),description=nullif(btrim(coalesce(p_description,'')),''),permissions=p_permissions,updated_at=now() where id=p_role_id and tenant_id=p_tenant_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_user_id,v_actor_platform_role,v_actor_tenant_role,'custom_permission_role',p_role_id::text,'update',v_before,jsonb_build_object('name',btrim(p_name),'description',nullif(btrim(coalesce(p_description,'')),''),'permissions',p_permissions));
  return query select p_role_id,'update'::text;
end; $$;

create or replace function public.powerhub_delete_custom_permission_role(p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_role_id bigint)
returns table(role_id bigint) language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_before jsonb; v_actor_role text; v_actor_platform_role text; v_actor_tenant_role text;
begin
  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role<>'admin' then select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_user_id and is_active=true and membership_status='active'; if v_actor_tenant_role<>'owner' then raise exception 'ROLE_MANAGEMENT_FORBIDDEN' using errcode='P0001'; end if; else v_actor_tenant_role:='platform_admin'; end if;
  perform pg_advisory_xact_lock(p_tenant_id,hashtext('custom-permission-role'));
  select to_jsonb(role) into v_before from public.custom_permission_roles role where role.id=p_role_id and role.tenant_id=p_tenant_id for update;
  if not found then raise exception 'CUSTOM_ROLE_NOT_FOUND' using errcode='P0001'; end if;
  if exists(select 1 from public.staff_profiles where tenant_id=p_tenant_id and custom_role_id=p_role_id and is_active=true for key share) then raise exception 'CUSTOM_ROLE_LINKED' using errcode='P0001'; end if;
  update public.custom_permission_roles set is_active=false,updated_at=now() where id=p_role_id and tenant_id=p_tenant_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_user_id,v_actor_platform_role,v_actor_tenant_role,'custom_permission_role',p_role_id::text,'delete',v_before,jsonb_build_object('isActive',false));
  return query select p_role_id;
end; $$;

create or replace function public.powerhub_update_staff_profile_permissions(p_tenant_id bigint,p_site_id bigint,p_actor_user_id bigint,p_profile_id bigint,p_custom_role_id bigint,p_permissions jsonb)
returns table(profile_id bigint,target_user_id bigint) language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_before jsonb; v_target_user_id bigint; v_actor_role text; v_actor_platform_role text; v_actor_tenant_role text;
begin
  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_actor_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role<>'admin' then select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_actor_user_id and is_active=true and membership_status='active'; if v_actor_tenant_role<>'owner' then raise exception 'STAFF_PERMISSION_MANAGEMENT_FORBIDDEN' using errcode='P0001'; end if; else v_actor_tenant_role:='platform_admin'; end if;
  if p_permissions is null or jsonb_typeof(p_permissions)<>'array' or jsonb_array_length(p_permissions)<1 then raise exception 'INVALID_STAFF_PERMISSIONS' using errcode='P0001'; end if;
  if exists(select 1 from jsonb_array_elements_text(p_permissions) capability(value) where capability.value not in ('manageSubscribers','manageGenerators','recordReadings','accessFieldApp','approveReadings','manageTariffs','issueInvoices','collectPayments','manageExpenses','managePayroll','manageTeam','manageMessaging','viewAudit')) then raise exception 'INVALID_STAFF_PERMISSION_CAPABILITY' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_tenant_id,hashtext('staff-profile-permissions'));
  if p_custom_role_id is not null and not exists(select 1 from public.custom_permission_roles where id=p_custom_role_id and tenant_id=p_tenant_id and is_active=true for key share) then raise exception 'CUSTOM_ROLE_NOT_FOUND' using errcode='P0001'; end if;
  select to_jsonb(profile),profile.user_id into v_before,v_target_user_id from public.staff_profiles profile where profile.id=p_profile_id and profile.tenant_id=p_tenant_id and (profile.site_id=p_site_id or profile.site_id is null) for update;
  if not found then raise exception 'STAFF_PROFILE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  update public.staff_profiles set custom_role_id=p_custom_role_id,permissions=p_permissions,updated_at=now() where id=p_profile_id and tenant_id=p_tenant_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_actor_user_id,v_actor_platform_role,v_actor_tenant_role,'staff_profile',p_profile_id::text,'update_permissions',v_before,jsonb_build_object('customRoleId',p_custom_role_id,'permissions',p_permissions,'targetUserId',v_target_user_id));
  return query select p_profile_id,v_target_user_id;
end; $$;

create or replace function public.powerhub_update_staff_profile_status(p_tenant_id bigint,p_site_id bigint,p_actor_user_id bigint,p_profile_id bigint,p_operation text,p_suspension_started_at timestamptz,p_suspension_ends_at timestamptz,p_is_active boolean)
returns table(profile_id bigint,is_active boolean,suspension_ends_at timestamptz) language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_before jsonb; v_target_user_id bigint; v_profile_active boolean; v_suspension_end timestamptz; v_actor_role text; v_actor_platform_role text; v_actor_tenant_role text; v_audit_action text; v_after jsonb;
begin
  if p_operation not in ('suspend','clear_suspension','set_active') then raise exception 'INVALID_STAFF_STATUS_OPERATION' using errcode='P0001'; end if;
  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_actor_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role<>'admin' then select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_actor_user_id and is_active=true and membership_status='active'; if v_actor_tenant_role<>'owner' then raise exception 'STAFF_STATUS_MANAGEMENT_FORBIDDEN' using errcode='P0001'; end if; else v_actor_tenant_role:='platform_admin'; end if;
  if p_operation='suspend' and (p_suspension_started_at is null or p_suspension_ends_at is null or p_suspension_ends_at<=p_suspension_started_at) then raise exception 'INVALID_SUSPENSION_WINDOW' using errcode='P0001'; end if;
  if p_operation='set_active' and p_is_active is null then raise exception 'MISSING_ACTIVE_STATE' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_tenant_id,hashtext('staff-profile-status'));
  select to_jsonb(profile),profile.user_id,profile.is_active,profile.suspension_ends_at into v_before,v_target_user_id,v_profile_active,v_suspension_end from public.staff_profiles profile where profile.id=p_profile_id and profile.tenant_id=p_tenant_id and (profile.site_id=p_site_id or profile.site_id is null) for update;
  if not found then raise exception 'STAFF_PROFILE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if p_operation='suspend' then
    update public.staff_profiles set suspension_started_at=p_suspension_started_at,suspension_ends_at=p_suspension_ends_at,updated_at=now() where id=p_profile_id and tenant_id=p_tenant_id;
    v_audit_action:='suspend_until'; v_after:=jsonb_build_object('targetUserId',v_target_user_id,'suspensionStartedAt',p_suspension_started_at,'suspensionEndsAt',p_suspension_ends_at); v_suspension_end:=p_suspension_ends_at;
  elsif p_operation='clear_suspension' then
    update public.staff_profiles set suspension_started_at=null,suspension_ends_at=null,updated_at=now() where id=p_profile_id and tenant_id=p_tenant_id;
    v_audit_action:='clear_suspension'; v_after:=jsonb_build_object('targetUserId',v_target_user_id); v_suspension_end:=null;
  else
    update public.staff_profiles set is_active=p_is_active,updated_at=now() where id=p_profile_id and tenant_id=p_tenant_id;
    v_audit_action:=case when p_is_active then 'activate' else 'deactivate' end; v_after:=jsonb_build_object('isActive',p_is_active,'userId',v_target_user_id); v_profile_active:=p_is_active;
  end if;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_actor_user_id,v_actor_platform_role,v_actor_tenant_role,'staff_profile',p_profile_id::text,v_audit_action,v_before,v_after);
  return query select p_profile_id,v_profile_active,v_suspension_end;
end; $$;

create or replace function public.powerhub_assign_existing_staff(p_tenant_id bigint,p_site_id bigint,p_actor_user_id bigint,p_target_user_id bigint,p_role text,p_all_branches boolean)
returns table(profile_id bigint,target_user_id bigint) language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_actor_role text; v_actor_platform_role text; v_actor_tenant_role text; v_existing_member_role text; v_existing_member_active boolean; v_existing_membership_status text; v_target_membership_role text; v_target_site_id bigint; v_plan text; v_policy_enabled boolean; v_roles_policy jsonb; v_limits_policy jsonb; v_overrides_policy jsonb; v_override jsonb; v_limit_text text; v_override_limit_text text; v_limit integer; v_current_count integer; v_already_active_subaccount boolean:=false; v_before_member jsonb; v_before_profiles jsonb; v_profile_id bigint;
begin
  if p_role not in ('owner','manager','accountant','collector','technician','viewer') then raise exception 'INVALID_STAFF_ROLE' using errcode='P0001'; end if;
  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_actor_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if not exists(select 1 from public.users where id=p_target_user_id) then raise exception 'TARGET_USER_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role<>'admin' then select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_actor_user_id and is_active=true and membership_status='active'; if v_actor_tenant_role<>'owner' then raise exception 'STAFF_ASSIGNMENT_FORBIDDEN' using errcode='P0001'; end if; else v_actor_tenant_role:='platform_admin'; end if;
  perform pg_advisory_xact_lock(p_tenant_id,hashtext('staff-assignment'));
  select to_jsonb(member),member.role,member.is_active,member.membership_status into v_before_member,v_existing_member_role,v_existing_member_active,v_existing_membership_status from public.tenant_members member where member.tenant_id=p_tenant_id and member.user_id=p_target_user_id for update;
  v_already_active_subaccount:=found and v_existing_member_role='member' and v_existing_member_active=true and v_existing_membership_status='active';
  v_target_membership_role:=case when found and v_existing_member_role='owner' then 'owner' else 'member' end;
  v_target_site_id:=case when p_all_branches then null else p_site_id end;
  select coalesce(jsonb_agg(to_jsonb(profile)),'[]'::jsonb) into v_before_profiles from public.staff_profiles profile where profile.tenant_id=p_tenant_id and profile.user_id=p_target_user_id and (profile.site_id=p_site_id or (p_all_branches and profile.site_id is null));
  select plan into v_plan from public.tenant_subscriptions where tenant_id=p_tenant_id; if v_plan is null then select plan into v_plan from public.tenants where id=p_tenant_id; end if;
  if v_plan not in ('starter','professional','enterprise') then raise exception 'TENANT_PLAN_NOT_FOUND' using errcode='P0001'; end if;
  select is_enabled,value into v_policy_enabled,v_roles_policy from public.platform_settings where setting_key='owner_subaccount_roles';
  select value into v_limits_policy from public.platform_settings where setting_key='owner_subaccount_limits';
  select value into v_overrides_policy from public.platform_settings where setting_key='owner_limit_overrides';
  v_override:=case when jsonb_typeof(v_overrides_policy->'overrides')='object' then v_overrides_policy->'overrides'->p_tenant_id::text else null end;
  if v_actor_role<>'admin' then
    if v_policy_enabled=false then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED' using errcode='P0001'; end if;
    if p_role='owner' then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED' using errcode='P0001'; end if;
    if jsonb_typeof(v_roles_policy->'allowedRoles')='array' and not (v_roles_policy->'allowedRoles' ? p_role) then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED' using errcode='P0001'; end if;
    if jsonb_typeof(v_override->'allowedRoles')='array' and not (v_override->'allowedRoles' ? p_role) then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED' using errcode='P0001'; end if;
  end if;
  v_limit:=case v_plan when 'starter' then 2 when 'professional' then 5 else 15 end;
  v_limit_text:=v_limits_policy->'limits'->>v_plan; if v_limit_text~'^\\d+$' and v_limit_text::integer between 0 and 999 then v_limit:=v_limit_text::integer; end if;
  v_override_limit_text:=v_override->>'subaccountLimit'; if v_override_limit_text~'^\\d+$' then v_limit:=v_override_limit_text::integer; end if;
  select count(*)::integer into v_current_count from public.tenant_members where tenant_id=p_tenant_id and role='member' and is_active=true and membership_status='active';
  if not v_already_active_subaccount and v_current_count>=v_limit then raise exception 'SUBACCOUNT_LIMIT_REACHED' using errcode='P0001'; end if;
  insert into public.tenant_members(tenant_id,user_id,role,is_active,membership_status,expires_at,invited_by_user_id) values(p_tenant_id,p_target_user_id,v_target_membership_role,true,'active',null,p_actor_user_id) on conflict(tenant_id,user_id) do update set role=excluded.role,is_active=true,membership_status='active',expires_at=null,updated_at=now();
  update public.staff_profiles set is_active=false,updated_at=now() where tenant_id=p_tenant_id and user_id=p_target_user_id and (site_id=p_site_id or (p_all_branches and site_id is null));
  insert into public.staff_profiles(tenant_id,site_id,user_id,role,is_active) values(p_tenant_id,v_target_site_id,p_target_user_id,p_role,true) on conflict(user_id,site_id,role) do update set is_active=true,updated_at=now() returning id into v_profile_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_actor_user_id,v_actor_platform_role,v_actor_tenant_role,'staff_profile',v_profile_id::text,'assign_role',jsonb_build_object('membership',v_before_member,'profiles',v_before_profiles),jsonb_build_object('targetUserId',p_target_user_id,'role',p_role,'allBranches',p_all_branches,'assignedSiteId',v_target_site_id,'membershipRole',v_target_membership_role));
  return query select v_profile_id,p_target_user_id;
end; $$;

revoke execute on function public.powerhub_create_company_account(bigint,bigint,bigint,text,text,text,numeric,text,bigint[]) from public,anon,authenticated;
revoke execute on function public.powerhub_add_account_movement(bigint,bigint,bigint,bigint,text,numeric,text,text) from public,anon,authenticated;
revoke execute on function public.powerhub_transfer_company_accounts(bigint,bigint,bigint,bigint,bigint,numeric,text) from public,anon,authenticated;
revoke execute on function public.powerhub_update_company_account_phone(bigint,bigint,bigint,bigint,text) from public,anon,authenticated;
revoke execute on function public.powerhub_update_company_account_opening_balance(bigint,bigint,bigint,bigint,numeric) from public,anon,authenticated;
revoke execute on function public.powerhub_update_company_account_sites(bigint,bigint,bigint,bigint,bigint[]) from public,anon,authenticated;
revoke execute on function public.powerhub_save_custom_permission_role(bigint,bigint,bigint,bigint,text,text,jsonb) from public,anon,authenticated;
revoke execute on function public.powerhub_delete_custom_permission_role(bigint,bigint,bigint,bigint) from public,anon,authenticated;
revoke execute on function public.powerhub_update_staff_profile_permissions(bigint,bigint,bigint,bigint,bigint,jsonb) from public,anon,authenticated;
revoke execute on function public.powerhub_update_staff_profile_status(bigint,bigint,bigint,bigint,text,timestamptz,timestamptz,boolean) from public,anon,authenticated;
revoke execute on function public.powerhub_assign_existing_staff(bigint,bigint,bigint,bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_create_company_account(bigint,bigint,bigint,text,text,text,numeric,text,bigint[]) to service_role;
grant execute on function public.powerhub_add_account_movement(bigint,bigint,bigint,bigint,text,numeric,text,text) to service_role;
grant execute on function public.powerhub_transfer_company_accounts(bigint,bigint,bigint,bigint,bigint,numeric,text) to service_role;
grant execute on function public.powerhub_update_company_account_phone(bigint,bigint,bigint,bigint,text) to service_role;
grant execute on function public.powerhub_update_company_account_opening_balance(bigint,bigint,bigint,bigint,numeric) to service_role;
grant execute on function public.powerhub_update_company_account_sites(bigint,bigint,bigint,bigint,bigint[]) to service_role;
grant execute on function public.powerhub_save_custom_permission_role(bigint,bigint,bigint,bigint,text,text,jsonb) to service_role;
grant execute on function public.powerhub_delete_custom_permission_role(bigint,bigint,bigint,bigint) to service_role;
grant execute on function public.powerhub_update_staff_profile_permissions(bigint,bigint,bigint,bigint,bigint,jsonb) to service_role;
grant execute on function public.powerhub_update_staff_profile_status(bigint,bigint,bigint,bigint,text,timestamptz,timestamptz,boolean) to service_role;
grant execute on function public.powerhub_assign_existing_staff(bigint,bigint,bigint,bigint,text,boolean) to service_role;
