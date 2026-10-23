-- Reconcile direct-client ACLs for tenant/site catalogs and restrict inventory reads
-- to a valid tenant member or an explicitly authorized active platform administrator.
-- This is forward-only and uses the helper namespace present in each environment.

revoke insert, update, delete, truncate
  on table public.sites, public.tenant_members
  from public, anon, authenticated;

-- Match the two production access-path indexes missing from staging.
create index if not exists sites_tenant_id_idx on public.sites (tenant_id);
create index if not exists tenant_members_user_active_idx on public.tenant_members (user_id, is_active);

do $$
declare
  tenant_guard text;
  admin_guard text;
  target record;
begin
  if to_regprocedure('powerhub_private.has_tenant_access(bigint)') is not null
     and to_regprocedure('powerhub_private.is_platform_admin()') is not null then
    tenant_guard := 'powerhub_private.has_tenant_access';
    admin_guard := 'powerhub_private.is_platform_admin';
  elsif to_regprocedure('private.powerhub_has_tenant_access(bigint)') is not null
        and to_regprocedure('private.powerhub_is_platform_admin()') is not null then
    tenant_guard := 'private.powerhub_has_tenant_access';
    admin_guard := 'private.powerhub_is_platform_admin';
  else
    raise exception 'POWERHUB_TENANT_AND_PLATFORM_ADMIN_GUARDS_NOT_FOUND';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.sites'::regclass
      and tgname = 'sites_set_updated_at'
      and not tgisinternal
  ) then
    execute 'create trigger sites_set_updated_at before update on public.sites for each row execute function public.powerhub_set_updated_at()';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.tenant_members'::regclass
      and tgname = 'tenant_members_set_updated_at'
      and not tgisinternal
  ) then
    execute 'create trigger tenant_members_set_updated_at before update on public.tenant_members for each row execute function public.powerhub_set_updated_at()';
  end if;

  execute 'drop policy if exists site_tenant_access on public.sites';
  execute 'drop policy if exists sites_tenant_isolation on public.sites';
  execute format(
    'create policy sites_tenant_isolation on public.sites for all to authenticated using (%s(tenant_id) or %s()) with check (%s(tenant_id) or %s())',
    tenant_guard, admin_guard, tenant_guard, admin_guard
  );

  execute 'drop policy if exists tenant_members_access on public.tenant_members';
  execute 'drop policy if exists tenant_members_member_read on public.tenant_members';
  execute format(
    'create policy tenant_members_member_read on public.tenant_members for select to authenticated using (%s(tenant_id) or %s())',
    tenant_guard, admin_guard
  );

  for target in
    select * from (values
      ('inventory_items', 'inventory_items_tenant_read'),
      ('inventory_stock_movements', 'inventory_stock_movements_tenant_read'),
      ('inventory_warehouses', 'inventory_warehouses_tenant_read'),
      ('supplier_ledger_entries', 'supplier_ledger_entries_tenant_read'),
      ('supplier_payment_allocations', 'supplier_payment_allocations_tenant_read'),
      ('supplier_payments', 'supplier_payments_tenant_read'),
      ('supplier_purchase_lines', 'supplier_purchase_lines_tenant_read'),
      ('supplier_purchase_receipt_lines', 'supplier_purchase_receipt_lines_tenant_read'),
      ('supplier_purchase_receipts', 'supplier_purchase_receipts_tenant_read'),
      ('supplier_purchases', 'supplier_purchases_tenant_read'),
      ('suppliers', 'suppliers_tenant_read')
    ) as policies(table_name, policy_name)
  loop
    execute format('drop policy if exists %I on public.%I', target.policy_name, target.table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (%s(tenant_id) or %s())',
      target.policy_name, target.table_name, tenant_guard, admin_guard
    );
  end loop;
end
$$;
