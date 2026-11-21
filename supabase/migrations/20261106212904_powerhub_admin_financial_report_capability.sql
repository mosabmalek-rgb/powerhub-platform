-- Extend platform-admin RPC allowlists for financial report visibility.
-- CREATE OR REPLACE preserves the existing restricted execution ACLs.
create or replace function public.powerhub_admin_set_staff_capability_override(
  p_actor_user_id bigint,
  p_profile_id bigint,
  p_capability text,
  p_is_allowed boolean
)
returns table(success boolean, profile_id bigint, capability text, is_allowed boolean)
language plpgsql security definer set search_path=public,pg_temp
as $$
declare
  v_actor public.users%rowtype;
  v_profile public.staff_profiles%rowtype;
  v_previous boolean;
begin
  select * into v_actor from public.users
  where id=p_actor_user_id and role='admin' and account_status='active'
    and platform_role in ('platform_owner','platform_admin');
  if not found then raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode='P0001'; end if;
  if p_capability not in (
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation','manageExpenses','viewFinancialReports','managePayroll','manageTeam',
    'manageMessaging','viewAudit','viewInventory','viewSuppliers','viewPurchases',
    'manageInventoryItems','manageSuppliers','createPurchases','approvePurchases',
    'receiveInventory','manageSupplierPayments','viewSupplierLedger','issueInventory',
    'adjustInventory','manageFuelAndConsumption','manageMaintenance','viewInventoryReports',
    'viewStocktakes','manageStocktakes','approveStocktakes',
    'createInventoryItems','editInventoryItems','deactivateInventoryItems',
    'createSuppliers','editSuppliers','deactivateSuppliers',
    'createWarehouses','editWarehouses','deactivateWarehouses'
  ,
    'reverseSupplierPayments'
  ) then raise exception 'INVALID_CAPABILITY' using errcode='P0001'; end if;
  select * into v_profile from public.staff_profiles where id=p_profile_id and tenant_id is not null;
  if not found then raise exception 'STAFF_PROFILE_NOT_FOUND' using errcode='P0001'; end if;
  if v_profile.role='owner' then raise exception 'OWNER_PERMISSION_OVERRIDE_NOT_SUPPORTED' using errcode='P0001'; end if;
  select o.is_allowed into v_previous from public.staff_profile_capability_overrides o
    where o.tenant_id=v_profile.tenant_id and o.profile_id=v_profile.id and o.capability=p_capability;
  insert into public.staff_profile_capability_overrides
    (tenant_id,profile_id,capability,is_allowed,updated_by_user_id,updated_at)
  values(v_profile.tenant_id,v_profile.id,p_capability,p_is_allowed,p_actor_user_id,now())
  on conflict on constraint staff_profile_capability_override_unique do update
    set is_allowed=excluded.is_allowed,updated_by_user_id=excluded.updated_by_user_id,updated_at=now();
  insert into public.staff_profile_permission_audit
    (tenant_id,profile_id,actor_user_id,capability,previous_is_allowed,new_is_allowed)
  values(v_profile.tenant_id,v_profile.id,p_actor_user_id,p_capability,v_previous,p_is_allowed);
  return query select true,v_profile.id,p_capability,p_is_allowed;
end;
$$;

create or replace function public.powerhub_admin_set_owner_capability_override(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_user_id bigint,
  p_capability text,
  p_is_allowed boolean
)
returns table(success boolean, tenant_id bigint, user_id bigint, capability text, is_allowed boolean, replayed boolean)
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_actor public.users%rowtype;
  v_previous boolean;
  v_existing boolean := false;
begin
  select * into v_actor from public.users actor
  where actor.id=p_actor_user_id
    and actor.role='admin'
    and actor.account_status='active'
    and actor.platform_role in ('platform_owner','platform_admin');
  if not found then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode='P0001';
  end if;

  if p_capability not in (
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation','manageExpenses','viewFinancialReports','managePayroll','manageTeam',
    'manageMessaging','viewAudit','viewInventory','viewSuppliers','viewPurchases',
    'manageInventoryItems','manageSuppliers','createPurchases','approvePurchases',
    'receiveInventory','manageSupplierPayments','viewSupplierLedger','issueInventory',
    'adjustInventory','manageFuelAndConsumption','manageMaintenance','viewInventoryReports',
    'viewStocktakes','manageStocktakes','approveStocktakes',
    'createInventoryItems','editInventoryItems','deactivateInventoryItems',
    'createSuppliers','editSuppliers','deactivateSuppliers',
    'createWarehouses','editWarehouses','deactivateWarehouses','reverseSupplierPayments'
  ) then
    raise exception 'INVALID_CAPABILITY' using errcode='P0001';
  end if;

  if not exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id=p_tenant_id and tm.user_id=p_user_id and tm.role='owner'
  ) then
    raise exception 'OWNER_MEMBERSHIP_NOT_FOUND' using errcode='P0001';
  end if;

  select o.is_allowed into v_previous
  from public.tenant_member_capability_overrides o
  where o.tenant_id=p_tenant_id and o.user_id=p_user_id and o.capability=p_capability;
  v_existing := found;
  if v_existing and v_previous = p_is_allowed then
    return query select true,p_tenant_id,p_user_id,p_capability,p_is_allowed,true;
    return;
  end if;

  insert into public.tenant_member_capability_overrides
    (tenant_id,user_id,capability,is_allowed,updated_by_user_id,updated_at)
  values (p_tenant_id,p_user_id,p_capability,p_is_allowed,p_actor_user_id,now())
  on conflict on constraint tenant_member_capability_override_unique do update
    set is_allowed=excluded.is_allowed,
        updated_by_user_id=excluded.updated_by_user_id,
        updated_at=now();

  insert into public.tenant_member_permission_audit
    (tenant_id,user_id,actor_user_id,capability,previous_is_allowed,new_is_allowed)
  values (p_tenant_id,p_user_id,p_actor_user_id,p_capability,v_previous,p_is_allowed);

  return query select true,p_tenant_id,p_user_id,p_capability,p_is_allowed,false;
end;
$$;

create or replace function public.powerhub_admin_save_role_policy(
  p_actor_user_id bigint,
  p_role text,
  p_capability text,
  p_is_allowed boolean
)
returns table(success boolean,policy_id bigint,role text,capability text,is_allowed boolean,replayed boolean)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_id bigint;
begin
  if not exists(select 1 from public.users actor where actor.id=p_actor_user_id
    and actor.role='admin' and actor.account_status='active'
    and actor.platform_role in ('platform_owner','platform_admin')) then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode='P0001';
  end if;
  if p_role not in ('owner','manager','accountant','collector','technician','viewer') then
    raise exception 'INVALID_ROLE' using errcode='P0001';
  end if;
  if p_capability not in (
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation','manageExpenses','viewFinancialReports','managePayroll','manageTeam',
    'manageMessaging','viewAudit','viewInventory','viewSuppliers','viewPurchases',
    'manageInventoryItems','manageSuppliers','createPurchases','approvePurchases',
    'receiveInventory','manageSupplierPayments','viewSupplierLedger','issueInventory',
    'adjustInventory','manageFuelAndConsumption','manageMaintenance','viewInventoryReports',
    'viewStocktakes','manageStocktakes','approveStocktakes',
    'createInventoryItems','editInventoryItems','deactivateInventoryItems',
    'createSuppliers','editSuppliers','deactivateSuppliers',
    'createWarehouses','editWarehouses','deactivateWarehouses'
  ,
    'reverseSupplierPayments'
  ) then raise exception 'INVALID_CAPABILITY' using errcode='P0001'; end if;
  insert into public.platform_role_policies(role,capability,is_allowed,updated_by_user_id,updated_at)
  values(p_role,p_capability,p_is_allowed,p_actor_user_id,now())
  on conflict on constraint platform_role_policies_role_capability_key do update
    set is_allowed=excluded.is_allowed,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()
  returning id into v_id;
  return query select true,v_id,p_role,p_capability,p_is_allowed,false;
end;
$$;
