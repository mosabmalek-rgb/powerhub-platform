-- Add a separate, auditable capability for reading supplier contact/catalog data.
-- Supplier directory visibility is distinct from access to supplier balances/ledgers.
-- This migration is additive; it does not rewrite the previously merged migration.

alter table public.platform_role_policies
  drop constraint if exists platform_role_policies_capability_check;
alter table public.platform_role_policies
  add constraint platform_role_policies_capability_check
  check (capability = any (array[
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation','manageExpenses','managePayroll','manageTeam',
    'manageMessaging','viewAudit',
    'viewInventory','viewSuppliers','manageInventoryItems','manageSuppliers','createPurchases',
    'approvePurchases','receiveInventory','manageSupplierPayments','viewSupplierLedger',
    'issueInventory','adjustInventory','manageFuelAndConsumption','manageMaintenance',
    'viewInventoryReports'
  ]));

alter table public.staff_profile_capability_overrides
  drop constraint if exists staff_profile_capability_overrides_capability_check;
alter table public.staff_profile_capability_overrides
  add constraint staff_profile_capability_overrides_capability_check
  check (capability = any (array[
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation','manageExpenses','managePayroll','manageTeam',
    'manageMessaging','viewAudit',
    'viewInventory','viewSuppliers','manageInventoryItems','manageSuppliers','createPurchases',
    'approvePurchases','receiveInventory','manageSupplierPayments','viewSupplierLedger',
    'issueInventory','adjustInventory','manageFuelAndConsumption','manageMaintenance',
    'viewInventoryReports'
  ]));

create or replace function public.powerhub_admin_set_staff_capability_override(
  p_actor_user_id bigint,
  p_profile_id bigint,
  p_capability text,
  p_is_allowed boolean
)
returns table(success boolean, profile_id bigint, capability text, is_allowed boolean)
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_actor public.users%rowtype;
  v_profile public.staff_profiles%rowtype;
  v_previous boolean;
begin
  select * into v_actor from public.users
  where id = p_actor_user_id and role = 'admin' and account_status = 'active'
    and platform_role in ('platform_owner','platform_admin');
  if not found then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode='P0001';
  end if;

  if p_capability not in (
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation','manageExpenses','managePayroll','manageTeam',
    'manageMessaging','viewAudit',
    'viewInventory','viewSuppliers','manageInventoryItems','manageSuppliers','createPurchases',
    'approvePurchases','receiveInventory','manageSupplierPayments','viewSupplierLedger',
    'issueInventory','adjustInventory','manageFuelAndConsumption','manageMaintenance',
    'viewInventoryReports'
  ) then
    raise exception 'INVALID_CAPABILITY' using errcode='P0001';
  end if;

  select * into v_profile from public.staff_profiles
  where id = p_profile_id and tenant_id is not null;
  if not found then
    raise exception 'STAFF_PROFILE_NOT_FOUND' using errcode='P0001';
  end if;
  if v_profile.role = 'owner' then
    raise exception 'OWNER_PERMISSION_OVERRIDE_NOT_SUPPORTED' using errcode='P0001';
  end if;

  select existing_override.is_allowed into v_previous
  from public.staff_profile_capability_overrides as existing_override
  where existing_override.tenant_id = v_profile.tenant_id
    and existing_override.profile_id = v_profile.id
    and existing_override.capability = p_capability;

  insert into public.staff_profile_capability_overrides
    (tenant_id, profile_id, capability, is_allowed, updated_by_user_id, updated_at)
  values
    (v_profile.tenant_id, v_profile.id, p_capability, p_is_allowed, p_actor_user_id, now())
  on conflict on constraint staff_profile_capability_override_unique do update
    set is_allowed = excluded.is_allowed,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_at = now();

  insert into public.staff_profile_permission_audit
    (tenant_id, profile_id, actor_user_id, capability, previous_is_allowed, new_is_allowed)
  values
    (v_profile.tenant_id, v_profile.id, p_actor_user_id, p_capability, v_previous, p_is_allowed);

  return query select true, v_profile.id, p_capability, p_is_allowed;
end;
$$;

revoke execute on function public.powerhub_admin_set_staff_capability_override(bigint,bigint,text,boolean) from public, anon, authenticated;
grant execute on function public.powerhub_admin_set_staff_capability_override(bigint,bigint,text,boolean) to service_role;

create or replace function public.powerhub_admin_save_role_policy(
  p_actor_user_id bigint,
  p_role text,
  p_capability text,
  p_is_allowed boolean
)
returns table(success boolean, policy_id bigint, role text, capability text, is_allowed boolean, replayed boolean)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_id bigint;
begin
  if not exists (
    select 1 from public.users as actor
    where actor.id = p_actor_user_id
      and actor.role = 'admin'
      and actor.account_status = 'active'
      and actor.platform_role in ('platform_owner','platform_admin')
  ) then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode='P0001';
  end if;
  if p_role not in ('owner','manager','accountant','collector','technician','viewer') then
    raise exception 'INVALID_ROLE' using errcode='P0001';
  end if;
  if p_capability not in (
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation','manageExpenses','managePayroll','manageTeam',
    'manageMessaging','viewAudit',
    'viewInventory','viewSuppliers','manageInventoryItems','manageSuppliers','createPurchases',
    'approvePurchases','receiveInventory','manageSupplierPayments','viewSupplierLedger',
    'issueInventory','adjustInventory','manageFuelAndConsumption','manageMaintenance',
    'viewInventoryReports'
  ) then
    raise exception 'INVALID_CAPABILITY' using errcode='P0001';
  end if;
  insert into public.platform_role_policies(role,capability,is_allowed,updated_by_user_id,updated_at)
  values(p_role,p_capability,p_is_allowed,p_actor_user_id,now())
  on conflict(role,capability) do update
    set is_allowed=excluded.is_allowed,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()
  returning id into v_id;
  return query select true,v_id,p_role,p_capability,p_is_allowed,false;
end;
$$;

revoke execute on function public.powerhub_admin_save_role_policy(bigint,text,text,boolean) from public, anon, authenticated;
grant execute on function public.powerhub_admin_save_role_policy(bigint,text,text,boolean) to service_role;
