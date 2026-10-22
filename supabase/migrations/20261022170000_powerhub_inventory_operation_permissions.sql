-- Split master-data CRUD permissions so each operation can be granted or denied independently.
alter table public.platform_role_policies
  drop constraint if exists platform_role_policies_capability_check;
alter table public.platform_role_policies
  add constraint platform_role_policies_capability_check
  check (capability = any (array[
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation','manageExpenses','managePayroll','manageTeam',
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
  ]));

alter table public.staff_profile_capability_overrides
  drop constraint if exists staff_profile_capability_overrides_capability_check;
alter table public.staff_profile_capability_overrides
  add constraint staff_profile_capability_overrides_capability_check
  check (capability = any (array[
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation','manageExpenses','managePayroll','manageTeam',
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
  ]));

-- Preserve existing grants/denials while migrating the former bundled capabilities.
insert into public.platform_role_policies(role,capability,is_allowed,updated_by_user_id,updated_at)
select p.role, c.capability, p.is_allowed, p.updated_by_user_id, now()
from public.platform_role_policies p
cross join lateral (values
  ('createInventoryItems'),('editInventoryItems'),('deactivateInventoryItems'),
  ('createWarehouses'),('editWarehouses'),('deactivateWarehouses')
) c(capability)
where p.capability='manageInventoryItems'
on conflict on constraint platform_role_policies_role_capability_key do nothing;

insert into public.platform_role_policies(role,capability,is_allowed,updated_by_user_id,updated_at)
select p.role, c.capability, p.is_allowed, p.updated_by_user_id, now()
from public.platform_role_policies p
cross join lateral (values ('createSuppliers'),('editSuppliers'),('deactivateSuppliers')) c(capability)
where p.capability='manageSuppliers'
on conflict on constraint platform_role_policies_role_capability_key do nothing;

insert into public.staff_profile_capability_overrides
  (tenant_id,profile_id,capability,is_allowed,updated_by_user_id,updated_at)
select o.tenant_id,o.profile_id,c.capability,o.is_allowed,o.updated_by_user_id,now()
from public.staff_profile_capability_overrides o
cross join lateral (values
  ('createInventoryItems'),('editInventoryItems'),('deactivateInventoryItems'),
  ('createWarehouses'),('editWarehouses'),('deactivateWarehouses')
) c(capability)
where o.capability='manageInventoryItems'
on conflict on constraint staff_profile_capability_override_unique do nothing;

insert into public.staff_profile_capability_overrides
  (tenant_id,profile_id,capability,is_allowed,updated_by_user_id,updated_at)
select o.tenant_id,o.profile_id,c.capability,o.is_allowed,o.updated_by_user_id,now()
from public.staff_profile_capability_overrides o
cross join lateral (values ('createSuppliers'),('editSuppliers'),('deactivateSuppliers')) c(capability)
where o.capability='manageSuppliers'
on conflict on constraint staff_profile_capability_override_unique do nothing;

update public.custom_permission_roles r
set permissions = (
  select coalesce(jsonb_agg(to_jsonb(capability) order by capability),'[]'::jsonb)
  from (
    select distinct capability
    from (
      select jsonb_array_elements_text(r.permissions) as capability
      union all
      select unnest(array[
        'createInventoryItems','editInventoryItems','deactivateInventoryItems',
        'createWarehouses','editWarehouses','deactivateWarehouses'
      ]) where r.permissions ? 'manageInventoryItems'
      union all
      select unnest(array['createSuppliers','editSuppliers','deactivateSuppliers'])
        where r.permissions ? 'manageSuppliers'
    ) expanded
  ) unique_caps
)
where r.permissions ? 'manageInventoryItems' or r.permissions ? 'manageSuppliers';

update public.staff_profiles p
set permissions = (
  select coalesce(jsonb_agg(to_jsonb(capability) order by capability),'[]'::jsonb)
  from (
    select distinct capability
    from (
      select jsonb_array_elements_text(p.permissions) as capability
      union all
      select unnest(array[
        'createInventoryItems','editInventoryItems','deactivateInventoryItems',
        'createWarehouses','editWarehouses','deactivateWarehouses'
      ]) where p.permissions ? 'manageInventoryItems'
      union all
      select unnest(array['createSuppliers','editSuppliers','deactivateSuppliers'])
        where p.permissions ? 'manageSuppliers'
    ) expanded
  ) unique_caps
)

where p.permissions is not null
  and (p.permissions ? 'manageInventoryItems' or p.permissions ? 'manageSuppliers');

-- Keep the former payment-management grant effective for reversals, while allowing
-- future per-user policy to deny reversal independently.
insert into public.platform_role_policies(role,capability,is_allowed,updated_by_user_id,updated_at)
select p.role,'reverseSupplierPayments',p.is_allowed,p.updated_by_user_id,now()
from public.platform_role_policies p
where p.capability='manageSupplierPayments'
on conflict on constraint platform_role_policies_role_capability_key do nothing;

insert into public.staff_profile_capability_overrides
  (tenant_id,profile_id,capability,is_allowed,updated_by_user_id,updated_at)
select o.tenant_id,o.profile_id,'reverseSupplierPayments',o.is_allowed,o.updated_by_user_id,now()
from public.staff_profile_capability_overrides o
where o.capability='manageSupplierPayments'
on conflict on constraint staff_profile_capability_override_unique do nothing;

update public.custom_permission_roles r
set permissions = (
  select coalesce(jsonb_agg(to_jsonb(capability) order by capability),'[]'::jsonb)
  from (
    select distinct capability
    from (
      select jsonb_array_elements_text(r.permissions) as capability
      union all select 'reverseSupplierPayments' where r.permissions ? 'manageSupplierPayments'
    ) expanded
  ) unique_caps
)
where r.permissions ? 'manageSupplierPayments';

update public.staff_profiles p
set permissions = (
  select coalesce(jsonb_agg(to_jsonb(capability) order by capability),'[]'::jsonb)
  from (
    select distinct capability
    from (
      select jsonb_array_elements_text(p.permissions) as capability
      union all select 'reverseSupplierPayments' where p.permissions ? 'manageSupplierPayments'
    ) expanded
  ) unique_caps
)
where p.permissions is not null and p.permissions ? 'manageSupplierPayments';

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
    'approvePaymentDocumentation','manageExpenses','managePayroll','manageTeam',
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
    'approvePaymentDocumentation','manageExpenses','managePayroll','manageTeam',
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

revoke execute on function public.powerhub_admin_set_staff_capability_override(bigint,bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_admin_set_staff_capability_override(bigint,bigint,text,boolean) to service_role;
revoke execute on function public.powerhub_admin_save_role_policy(bigint,text,text,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_admin_save_role_policy(bigint,text,text,boolean) to service_role;
