-- Atomic purchase draft, approval, and partial/full receipt workflow.
-- Stock movements, receipt records, supplier liability, and audit entries commit atomically.
-- Mutations remain callable only by service_role; user capabilities are checked server-side.

alter table public.supplier_purchases
  add column if not exists create_payload_hash text;

create sequence if not exists public.supplier_purchase_number_seq;
create sequence if not exists public.supplier_purchase_receipt_number_seq;

alter table public.platform_role_policies
  drop constraint if exists platform_role_policies_capability_check;
alter table public.platform_role_policies
  add constraint platform_role_policies_capability_check
  check (capability = any (array[
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation','manageExpenses','managePayroll','manageTeam',
    'manageMessaging','viewAudit',
    'viewInventory','viewSuppliers','viewPurchases','manageInventoryItems','manageSuppliers','createPurchases',
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
    'viewInventory','viewSuppliers','viewPurchases','manageInventoryItems','manageSuppliers','createPurchases',
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
    'viewInventory','viewSuppliers','viewPurchases','manageInventoryItems','manageSuppliers','createPurchases',
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
    'viewInventory','viewSuppliers','viewPurchases','manageInventoryItems','manageSuppliers','createPurchases',
    'approvePurchases','receiveInventory','manageSupplierPayments','viewSupplierLedger',
    'issueInventory','adjustInventory','manageFuelAndConsumption','manageMaintenance',
    'viewInventoryReports'
  ) then
    raise exception 'INVALID_CAPABILITY' using errcode='P0001';
  end if;
  insert into public.platform_role_policies(role,capability,is_allowed,updated_by_user_id,updated_at)
  values(p_role,p_capability,p_is_allowed,p_actor_user_id,now())
  on conflict on constraint platform_role_policies_role_capability_key do update
    set is_allowed=excluded.is_allowed,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()
  returning id into v_id;
  return query select true,v_id,p_role,p_capability,p_is_allowed,false;
end;
$$;

revoke execute on function public.powerhub_admin_save_role_policy(bigint,text,text,boolean) from public, anon, authenticated;
grant execute on function public.powerhub_admin_save_role_policy(bigint,text,text,boolean) to service_role;

create table public.supplier_purchase_receipts (
  id bigint generated by default as identity primary key,
  tenant_id bigint not null references public.tenants(id) on delete cascade,
  site_id bigint not null,
  purchase_id bigint not null,
  receipt_number text not null,
  receipt_date date not null default current_date,
  operation_key text not null check (length(trim(operation_key)) between 1 and 180),
  payload_hash text not null check (length(payload_hash) = 32),
  notes text,
  received_at timestamptz not null default now(),
  received_by_user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, receipt_number),
  unique (tenant_id, operation_key),
  constraint supplier_purchase_receipts_site_tenant_fk
    foreign key (tenant_id, site_id) references public.sites (tenant_id, id) on delete restrict,
  constraint supplier_purchase_receipts_purchase_tenant_fk
    foreign key (tenant_id, purchase_id) references public.supplier_purchases (tenant_id, id) on delete restrict
);

create index supplier_purchase_receipts_purchase_date_idx
  on public.supplier_purchase_receipts (tenant_id, purchase_id, receipt_date desc, id desc);

create table public.supplier_purchase_receipt_lines (
  id bigint generated by default as identity primary key,
  tenant_id bigint not null references public.tenants(id) on delete cascade,
  receipt_id bigint not null,
  purchase_id bigint not null,
  purchase_line_id bigint not null,
  stock_movement_id bigint not null,
  quantity numeric(14,3) not null check (quantity > 0),
  base_quantity numeric(14,3) not null check (base_quantity > 0),
  unit_cost numeric(14,4) not null check (unit_cost >= 0),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, receipt_id, purchase_line_id),
  unique (tenant_id, stock_movement_id),
  constraint supplier_purchase_receipt_lines_receipt_tenant_fk
    foreign key (tenant_id, receipt_id) references public.supplier_purchase_receipts (tenant_id, id) on delete restrict,
  constraint supplier_purchase_receipt_lines_purchase_tenant_fk
    foreign key (tenant_id, purchase_id) references public.supplier_purchases (tenant_id, id) on delete restrict,
  constraint supplier_purchase_receipt_lines_purchase_line_tenant_fk
    foreign key (tenant_id, purchase_line_id) references public.supplier_purchase_lines (tenant_id, id) on delete restrict,
  constraint supplier_purchase_receipt_lines_movement_tenant_fk
    foreign key (tenant_id, stock_movement_id) references public.inventory_stock_movements (tenant_id, id) on delete restrict
);

create index supplier_purchase_receipt_lines_purchase_idx
  on public.supplier_purchase_receipt_lines (tenant_id, purchase_id, receipt_id, purchase_line_id);

do $rls$
declare table_name text;
begin
  foreach table_name in array array['supplier_purchase_receipts','supplier_purchase_receipt_lines']
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists %I on public.%I', table_name || '_tenant_read', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (tenant_id = any(powerhub_private.current_tenant_ids()) or powerhub_private.is_platform_user())',
      table_name || '_tenant_read', table_name
    );
    execute format('revoke all on table public.%I from public, anon', table_name);
    execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from authenticated', table_name);
    execute format('grant select on table public.%I to authenticated', table_name);
    execute format('grant all on table public.%I to service_role', table_name);
    execute format('grant usage, select on sequence public.%I to service_role', table_name || '_id_seq');
  end loop;
end;
$rls$;

grant usage, select on sequence public.supplier_purchase_number_seq,
  public.supplier_purchase_receipt_number_seq to service_role;

create or replace function public.powerhub_inventory_create_purchase(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_supplier_id bigint,
  p_warehouse_id bigint,
  p_supplier_invoice_no text,
  p_invoice_date date,
  p_due_date date,
  p_payment_terms_days integer,
  p_reference_no text,
  p_notes text,
  p_operation_key text,
  p_lines jsonb
)
returns table(
  purchase_id bigint, tenant_id bigint, site_id bigint, supplier_id bigint, warehouse_id bigint,
  purchase_number text, supplier_invoice_no text, invoice_date date, due_date date, status text,
  subtotal_amount numeric, discount_amount numeric, tax_amount numeric, other_charges_amount numeric,
  total_amount numeric, payment_terms_days integer, operation_key text, created_at timestamptz,
  updated_at timestamptz, replayed boolean
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_purchase public.supplier_purchases%rowtype;
  v_supplier public.suppliers%rowtype;
  v_line record;
  v_platform_role text;
  v_hash text;
  v_terms integer;
  v_invoice_date date;
  v_due_date date;
  v_line_count integer;
  v_subtotal numeric(14,2);
  v_discount numeric(14,2);
  v_tax numeric(14,2);
begin
  if p_operation_key is null or length(btrim(p_operation_key)) not between 1 and 180 then
    raise exception 'INVALID_OPERATION_KEY' using errcode='P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1
    or jsonb_array_length(p_lines) > 200 then
    raise exception 'INVALID_PURCHASE_LINES' using errcode='P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':purchase:' || btrim(p_operation_key), 0));

  v_invoice_date := coalesce(p_invoice_date,current_date);
  v_hash := md5(jsonb_build_object(
    'site_id',p_site_id,'supplier_id',p_supplier_id,'warehouse_id',p_warehouse_id,
    'supplier_invoice_no',nullif(btrim(p_supplier_invoice_no),''),'invoice_date',v_invoice_date,
    'due_date',p_due_date,'payment_terms_days',p_payment_terms_days,
    'reference_no',nullif(btrim(p_reference_no),''),'notes',nullif(btrim(p_notes),''),'lines',p_lines
  )::text);

  select p.* into v_purchase
  from public.supplier_purchases as p
  where p.tenant_id=p_tenant_id and p.operation_key=btrim(p_operation_key)
  for update;
  if found then
    if v_purchase.create_payload_hash is distinct from v_hash then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='P0001';
    end if;
    return query select v_purchase.id,v_purchase.tenant_id,v_purchase.site_id,v_purchase.supplier_id,
      v_purchase.warehouse_id,v_purchase.purchase_number,v_purchase.supplier_invoice_no,v_purchase.invoice_date,
      v_purchase.due_date,v_purchase.status,v_purchase.subtotal_amount,v_purchase.discount_amount,v_purchase.tax_amount,
      v_purchase.other_charges_amount,v_purchase.total_amount,v_purchase.payment_terms_days,v_purchase.operation_key,
      v_purchase.created_at,v_purchase.updated_at,true;
    return;
  end if;

  perform 1 from public.sites as s where s.id=p_site_id and s.tenant_id=p_tenant_id;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select * into v_supplier from public.suppliers as s
  where s.tenant_id=p_tenant_id and s.id=p_supplier_id and s.is_active=true;
  if not found then raise exception 'SUPPLIER_OUT_OF_SCOPE' using errcode='P0001'; end if;

  perform 1 from public.inventory_warehouses as w
  where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=p_warehouse_id and w.is_active=true;
  if not found then raise exception 'WAREHOUSE_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select u.platform_role into v_platform_role from public.users as u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_lines) as l(
      item_id bigint, quantity numeric, unit text, units_to_base_factor numeric,
      unit_price numeric, discount_amount numeric, tax_amount numeric, notes text
    )
    where l.item_id is null or l.quantity is null or l.quantity <= 0
      or l.unit is null or length(btrim(l.unit)) not between 1 and 40
      or l.units_to_base_factor is null or l.units_to_base_factor <= 0
      or l.quantity*1000 <> trunc(l.quantity*1000)
      or l.units_to_base_factor*1000000 <> trunc(l.units_to_base_factor*1000000)
      or l.unit_price is null or l.unit_price < 0 or l.unit_price*10000 <> trunc(l.unit_price*10000)
      or coalesce(l.discount_amount,0) < 0 or coalesce(l.discount_amount,0)*100 <> trunc(coalesce(l.discount_amount,0)*100)
      or coalesce(l.tax_amount,0) < 0 or coalesce(l.tax_amount,0)*100 <> trunc(coalesce(l.tax_amount,0)*100)
      or coalesce(l.discount_amount,0) > round(l.quantity*l.unit_price,2)
      or round(l.quantity*l.unit_price,2)-coalesce(l.discount_amount,0)+coalesce(l.tax_amount,0) < 0
  ) then
    raise exception 'INVALID_PURCHASE_LINES' using errcode='P0001';
  end if;

  for v_line in
    select l.item_id from jsonb_to_recordset(p_lines) as l(
      item_id bigint, quantity numeric, unit text, units_to_base_factor numeric,
      unit_price numeric, discount_amount numeric, tax_amount numeric, notes text
    )
  loop
    perform 1 from public.inventory_items as i
    where i.tenant_id=p_tenant_id and i.id=v_line.item_id and i.is_active=true;
    if not found then raise exception 'ITEM_OUT_OF_SCOPE' using errcode='P0001'; end if;
  end loop;

  select count(*)::integer,
    coalesce(sum(round(l.quantity*l.unit_price,2)),0)::numeric(14,2),
    coalesce(sum(coalesce(l.discount_amount,0)),0)::numeric(14,2),
    coalesce(sum(coalesce(l.tax_amount,0)),0)::numeric(14,2)
  into v_line_count,v_subtotal,v_discount,v_tax
  from jsonb_to_recordset(p_lines) as l(
    item_id bigint, quantity numeric, unit text, units_to_base_factor numeric,
    unit_price numeric, discount_amount numeric, tax_amount numeric, notes text
  );
  if v_line_count < 1 then raise exception 'INVALID_PURCHASE_LINES' using errcode='P0001'; end if;

  v_terms := coalesce(p_payment_terms_days,v_supplier.default_payment_terms_days);
  if v_terms < 0 or v_terms > 3650 then raise exception 'INVALID_PAYMENT_TERMS' using errcode='P0001'; end if;
  v_due_date := coalesce(p_due_date,v_invoice_date+v_terms);
  if v_due_date < v_invoice_date then raise exception 'INVALID_DUE_DATE' using errcode='P0001'; end if;

  insert into public.supplier_purchases(
    tenant_id,site_id,supplier_id,warehouse_id,purchase_number,supplier_invoice_no,invoice_date,due_date,
    status,subtotal_amount,discount_amount,tax_amount,other_charges_amount,payment_terms_days,
    reference_no,notes,operation_key,create_payload_hash,created_by_user_id
  ) values (
    p_tenant_id,p_site_id,p_supplier_id,p_warehouse_id,
    'PUR-'||to_char(v_invoice_date,'YYYYMMDD')||'-'||lpad(nextval('public.supplier_purchase_number_seq')::text,6,'0'),
    nullif(btrim(p_supplier_invoice_no),''),v_invoice_date,v_due_date,'draft',
    v_subtotal,v_discount,v_tax,0,v_terms,nullif(btrim(p_reference_no),''),nullif(btrim(p_notes),''),
    btrim(p_operation_key),v_hash,p_user_id
  ) returning * into v_purchase;

  for v_line in
    select l.* from jsonb_to_recordset(p_lines) as l(
      item_id bigint, quantity numeric, unit text, units_to_base_factor numeric,
      unit_price numeric, discount_amount numeric, tax_amount numeric, notes text
    )
  loop
    insert into public.supplier_purchase_lines(
      tenant_id,purchase_id,item_id,quantity,unit,units_to_base_factor,unit_price,discount_amount,tax_amount,notes
    ) values (
      p_tenant_id,v_purchase.id,v_line.item_id,v_line.quantity,btrim(v_line.unit),v_line.units_to_base_factor,
      v_line.unit_price,coalesce(v_line.discount_amount,0),coalesce(v_line.tax_amount,0),nullif(btrim(v_line.notes),'')
    );
  end loop;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'supplier_purchase',v_purchase.id::text,'create_draft',
    jsonb_build_object('purchaseNumber',v_purchase.purchase_number,'supplierId',v_purchase.supplier_id,
      'warehouseId',v_purchase.warehouse_id,'supplierInvoiceNo',v_purchase.supplier_invoice_no,
      'referenceNo',v_purchase.reference_no,'lineCount',v_line_count,'totalAmount',v_purchase.total_amount,'status',v_purchase.status)
  );

  return query select v_purchase.id,v_purchase.tenant_id,v_purchase.site_id,v_purchase.supplier_id,
    v_purchase.warehouse_id,v_purchase.purchase_number,v_purchase.supplier_invoice_no,v_purchase.invoice_date,
    v_purchase.due_date,v_purchase.status,v_purchase.subtotal_amount,v_purchase.discount_amount,v_purchase.tax_amount,
    v_purchase.other_charges_amount,v_purchase.total_amount,v_purchase.payment_terms_days,v_purchase.operation_key,
    v_purchase.created_at,v_purchase.updated_at,false;
end;
$$;

create or replace function public.powerhub_inventory_confirm_purchase(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_purchase_id bigint
)
returns table(
  purchase_id bigint, purchase_number text, status text, subtotal_amount numeric, discount_amount numeric,
  tax_amount numeric, other_charges_amount numeric, total_amount numeric, confirmed_at timestamptz,
  updated_at timestamptz, replayed boolean
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_purchase public.supplier_purchases%rowtype;
  v_platform_role text;
  v_line_count integer;
begin
  select p.* into v_purchase from public.supplier_purchases as p
  where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.id=p_purchase_id
  for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode='P0001'; end if;

  select u.platform_role into v_platform_role from public.users as u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  if v_purchase.status in ('confirmed','partially_received','received') then
    return query select v_purchase.id,v_purchase.purchase_number,v_purchase.status,v_purchase.subtotal_amount,
      v_purchase.discount_amount,v_purchase.tax_amount,v_purchase.other_charges_amount,v_purchase.total_amount,
      v_purchase.confirmed_at,v_purchase.updated_at,true;
    return;
  end if;
  if v_purchase.status <> 'draft' then
    raise exception 'PURCHASE_STATE_CONFLICT' using errcode='P0001';
  end if;

  select count(*)::integer into v_line_count from public.supplier_purchase_lines as l
  where l.tenant_id=p_tenant_id and l.purchase_id=v_purchase.id;
  if v_line_count < 1 then raise exception 'PURCHASE_HAS_NO_LINES' using errcode='P0001'; end if;

  update public.supplier_purchases as p
    set status='confirmed',confirmed_at=now(),confirmed_by_user_id=p_user_id,updated_at=now()
  where p.tenant_id=p_tenant_id and p.id=v_purchase.id
  returning * into v_purchase;

  if v_purchase.total_amount > 0 then
    insert into public.supplier_ledger_entries(
      tenant_id,site_id,supplier_id,entry_type,credit_amount,purchase_id,entry_key,reference_no,description,occurred_at,created_by_user_id
    ) values (
      p_tenant_id,p_site_id,v_purchase.supplier_id,'purchase',v_purchase.total_amount,v_purchase.id,
      'purchase:'||v_purchase.id,v_purchase.supplier_invoice_no,
      'فاتورة مشتريات '||v_purchase.purchase_number,v_purchase.confirmed_at,p_user_id
    );
  end if;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'supplier_purchase',v_purchase.id::text,'confirm',
    jsonb_build_object('status','draft'),
    jsonb_build_object('purchaseNumber',v_purchase.purchase_number,'status',v_purchase.status,
      'totalAmount',v_purchase.total_amount,'supplierId',v_purchase.supplier_id)
  );

  return query select v_purchase.id,v_purchase.purchase_number,v_purchase.status,v_purchase.subtotal_amount,
    v_purchase.discount_amount,v_purchase.tax_amount,v_purchase.other_charges_amount,v_purchase.total_amount,
    v_purchase.confirmed_at,v_purchase.updated_at,false;
end;
$$;

create or replace function public.powerhub_inventory_receive_purchase(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_purchase_id bigint,
  p_receipt_date date,
  p_operation_key text,
  p_notes text,
  p_lines jsonb
)
returns table(
  receipt_id bigint, receipt_number text, purchase_id bigint, purchase_number text,
  purchase_status text, received_at timestamptz, replayed boolean
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_purchase public.supplier_purchases%rowtype;
  v_receipt public.supplier_purchase_receipts%rowtype;
  v_purchase_line public.supplier_purchase_lines%rowtype;
  v_line record;
  v_platform_role text;
  v_hash text;
  v_base_quantity numeric(14,3);
  v_unit_cost numeric(14,4);
  v_stock_movement_id bigint;
  v_status text;
  v_line_count integer := 0;
begin
  if p_operation_key is null or length(btrim(p_operation_key)) not between 1 and 180 then
    raise exception 'INVALID_OPERATION_KEY' using errcode='P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1
    or jsonb_array_length(p_lines) > 200 then
    raise exception 'INVALID_RECEIPT_LINES' using errcode='P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':receipt:' || btrim(p_operation_key), 0));

  v_hash := md5(jsonb_build_object(
    'site_id',p_site_id,'purchase_id',p_purchase_id,'receipt_date',coalesce(p_receipt_date,current_date),
    'notes',nullif(btrim(p_notes),''),'lines',p_lines
  )::text);

  select r.* into v_receipt from public.supplier_purchase_receipts as r
  where r.tenant_id=p_tenant_id and r.operation_key=btrim(p_operation_key)
  for update;
  if found then
    if v_receipt.payload_hash is distinct from v_hash then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='P0001';
    end if;
    select p.* into v_purchase from public.supplier_purchases as p
    where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.id=v_receipt.purchase_id;
    if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode='P0001'; end if;
    return query select v_receipt.id,v_receipt.receipt_number,v_purchase.id,v_purchase.purchase_number,
      v_purchase.status,v_receipt.received_at,true;
    return;
  end if;

  select p.* into v_purchase from public.supplier_purchases as p
  where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.id=p_purchase_id
  for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode='P0001'; end if;
  if v_purchase.status not in ('confirmed','partially_received') then
    raise exception 'PURCHASE_NOT_RECEIVABLE' using errcode='P0001';
  end if;

  select u.platform_role into v_platform_role from public.users as u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  if exists (
    select 1 from jsonb_to_recordset(p_lines) as l(purchase_line_id bigint, quantity numeric)
    where l.purchase_line_id is null or l.quantity is null or l.quantity <= 0
      or l.quantity*1000 <> trunc(l.quantity*1000)
  ) then
    raise exception 'INVALID_RECEIPT_LINES' using errcode='P0001';
  end if;
  if exists (
    select l.purchase_line_id
    from jsonb_to_recordset(p_lines) as l(purchase_line_id bigint, quantity numeric)
    group by l.purchase_line_id having count(*) > 1
  ) then
    raise exception 'DUPLICATE_PURCHASE_LINE' using errcode='P0001';
  end if;

  insert into public.supplier_purchase_receipts(
    tenant_id,site_id,purchase_id,receipt_number,receipt_date,operation_key,payload_hash,notes,received_by_user_id
  ) values (
    p_tenant_id,p_site_id,v_purchase.id,
    'REC-'||to_char(coalesce(p_receipt_date,current_date),'YYYYMMDD')||'-'||lpad(nextval('public.supplier_purchase_receipt_number_seq')::text,6,'0'),
    coalesce(p_receipt_date,current_date),btrim(p_operation_key),v_hash,nullif(btrim(p_notes),''),p_user_id
  ) returning * into v_receipt;

  for v_line in
    select l.purchase_line_id,l.quantity
    from jsonb_to_recordset(p_lines) as l(purchase_line_id bigint, quantity numeric)
    order by l.purchase_line_id
  loop
    select l.* into v_purchase_line
    from public.supplier_purchase_lines as l
    where l.tenant_id=p_tenant_id and l.purchase_id=v_purchase.id and l.id=v_line.purchase_line_id
    for update;
    if not found then raise exception 'PURCHASE_LINE_NOT_FOUND' using errcode='P0001'; end if;
    if v_line.quantity > v_purchase_line.quantity-v_purchase_line.received_quantity then
      raise exception 'OVER_RECEIPT' using errcode='P0001';
    end if;

    v_base_quantity := round(v_line.quantity*v_purchase_line.units_to_base_factor,3);
    if v_base_quantity <= 0 then raise exception 'INVALID_RECEIPT_LINES' using errcode='P0001'; end if;
    v_unit_cost := round(v_purchase_line.line_total/(v_purchase_line.quantity*v_purchase_line.units_to_base_factor),4);

    insert into public.inventory_stock_movements(
      tenant_id,site_id,warehouse_id,item_id,movement_type,quantity,unit_cost,purchase_id,purchase_line_id,
      reference_no,notes,operation_key,occurred_at,created_by_user_id
    ) values (
      p_tenant_id,p_site_id,v_purchase.warehouse_id,v_purchase_line.item_id,'purchase_receipt',
      v_base_quantity,v_unit_cost,v_purchase.id,v_purchase_line.id,v_receipt.receipt_number,
      nullif(btrim(p_notes),''),'purchase-receipt:'||v_receipt.id||':line:'||v_purchase_line.id,
      v_receipt.received_at,p_user_id
    ) returning id into v_stock_movement_id;

    insert into public.supplier_purchase_receipt_lines(
      tenant_id,receipt_id,purchase_id,purchase_line_id,stock_movement_id,quantity,base_quantity,unit_cost
    ) values (
      p_tenant_id,v_receipt.id,v_purchase.id,v_purchase_line.id,v_stock_movement_id,
      v_line.quantity,v_base_quantity,v_unit_cost
    );

    update public.supplier_purchase_lines as l
      set received_quantity=l.received_quantity+v_line.quantity,updated_at=now()
    where l.tenant_id=p_tenant_id and l.id=v_purchase_line.id;
    v_line_count := v_line_count+1;
  end loop;

  if exists (
    select 1 from public.supplier_purchase_lines as l
    where l.tenant_id=p_tenant_id and l.purchase_id=v_purchase.id and l.received_quantity<l.quantity
  ) then
    v_status := 'partially_received';
  else
    v_status := 'received';
  end if;

  update public.supplier_purchases as p
    set status=v_status,received_at=coalesce(p.received_at,v_receipt.received_at),
        received_by_user_id=coalesce(p.received_by_user_id,p_user_id),updated_at=now()
  where p.tenant_id=p_tenant_id and p.id=v_purchase.id
  returning * into v_purchase;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'supplier_purchase_receipt',v_receipt.id::text,'receive',
    jsonb_build_object('receiptNumber',v_receipt.receipt_number,'purchaseId',v_purchase.id,
      'purchaseNumber',v_purchase.purchase_number,'purchaseStatus',v_purchase.status,'lineCount',v_line_count),
    jsonb_build_object('operationKey',v_receipt.operation_key)
  );

  return query select v_receipt.id,v_receipt.receipt_number,v_purchase.id,v_purchase.purchase_number,
    v_purchase.status,v_receipt.received_at,false;
end;
$$;

revoke execute on function public.powerhub_inventory_create_purchase(bigint,bigint,bigint,bigint,bigint,text,date,date,integer,text,text,text,jsonb) from public, anon, authenticated;
revoke execute on function public.powerhub_inventory_confirm_purchase(bigint,bigint,bigint,bigint) from public, anon, authenticated;
revoke execute on function public.powerhub_inventory_receive_purchase(bigint,bigint,bigint,bigint,date,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.powerhub_inventory_create_purchase(bigint,bigint,bigint,bigint,bigint,text,date,date,integer,text,text,text,jsonb) to service_role;
grant execute on function public.powerhub_inventory_confirm_purchase(bigint,bigint,bigint,bigint) to service_role;
grant execute on function public.powerhub_inventory_receive_purchase(bigint,bigint,bigint,bigint,date,text,text,jsonb) to service_role;
