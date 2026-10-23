-- Explicit supplier permanence and immediate/deferred purchase mode.
-- Legacy rows stay compatible by inheriting permanent/deferred defaults.
alter table public.suppliers add column if not exists supplier_type text not null default 'permanent';
do $supplier_type_constraints$
begin
 if not exists(select 1 from pg_constraint where conrelid='public.suppliers'::regclass and conname='suppliers_supplier_type_ck') then
  alter table public.suppliers add constraint suppliers_supplier_type_ck check(supplier_type in ('permanent','one_time'));
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.suppliers'::regclass and conname='suppliers_one_time_terms_ck') then
  alter table public.suppliers add constraint suppliers_one_time_terms_ck check(supplier_type<>'one_time' or default_payment_terms_days=0);
 end if;
end;
$supplier_type_constraints$;
alter table public.supplier_purchases add column if not exists payment_mode text not null default 'deferred';
do $purchase_mode_constraints$
begin
 if not exists(select 1 from pg_constraint where conrelid='public.supplier_purchases'::regclass and conname='supplier_purchases_payment_mode_ck') then
  alter table public.supplier_purchases add constraint supplier_purchases_payment_mode_ck check(payment_mode in ('immediate','deferred'));
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.supplier_purchases'::regclass and conname='supplier_purchases_immediate_terms_ck') then
  alter table public.supplier_purchases add constraint supplier_purchases_immediate_terms_ck check(payment_mode<>'immediate' or (payment_terms_days=0 and due_date=invoice_date));
 end if;
end;
$purchase_mode_constraints$;


create or replace function public.powerhub_inventory_create_supplier_with_type(
 p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_supplier_code text,p_name text,
 p_contact_name text,p_phone text,p_email text,p_address text,p_tax_number text,
 p_default_payment_terms_days integer,p_notes text,p_supplier_type text
)
returns table(id bigint,tenant_id bigint,supplier_code text,name text,contact_name text,phone text,
 email text,address text,tax_number text,default_payment_terms_days integer,supplier_type text,
 notes text,is_active boolean,created_at timestamptz,updated_at timestamptz)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_supplier_id bigint; v_supplier public.suppliers%rowtype; v_platform_role text;
begin
 if p_supplier_type is null or p_supplier_type not in ('permanent','one_time') then
   raise exception 'INVALID_SUPPLIER_TYPE' using errcode='P0001';
 end if;
 if p_supplier_type='one_time' and coalesce(p_default_payment_terms_days,0)<>0 then
   raise exception 'INVALID_ONE_TIME_SUPPLIER_TERMS' using errcode='P0001';
 end if;
 select created.id into v_supplier_id from public.powerhub_inventory_create_supplier(
   p_tenant_id,p_site_id,p_user_id,p_supplier_code,p_name,p_contact_name,p_phone,p_email,
   p_address,p_tax_number,p_default_payment_terms_days,p_notes
 ) as created;
 update public.suppliers set supplier_type=p_supplier_type
   where tenant_id=p_tenant_id and id=v_supplier_id returning * into v_supplier;
 select platform_role into v_platform_role from public.users where id=p_user_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data)
 values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'supplier',v_supplier.id::text,'set_supplier_type',
   jsonb_build_object('supplierType','permanent'),jsonb_build_object('supplierType',v_supplier.supplier_type));
 return query select v_supplier.id,v_supplier.tenant_id,v_supplier.supplier_code,v_supplier.name,
   v_supplier.contact_name,v_supplier.phone,v_supplier.email,v_supplier.address,v_supplier.tax_number,
   v_supplier.default_payment_terms_days,v_supplier.supplier_type,v_supplier.notes,v_supplier.is_active,
   v_supplier.created_at,v_supplier.updated_at;
end;
$$;

create or replace function public.powerhub_inventory_update_supplier_with_type(
 p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_supplier_id bigint,p_supplier_code text,
 p_name text,p_contact_name text,p_phone text,p_email text,p_address text,p_tax_number text,
 p_default_payment_terms_days integer,p_notes text,p_supplier_type text
)
returns table(id bigint,tenant_id bigint,supplier_code text,name text,contact_name text,phone text,
 email text,address text,tax_number text,default_payment_terms_days integer,supplier_type text,
 notes text,is_active boolean,created_at timestamptz,updated_at timestamptz)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_old_type text; v_supplier public.suppliers%rowtype; v_platform_role text;
begin
 if p_supplier_type is null or p_supplier_type not in ('permanent','one_time') then
   raise exception 'INVALID_SUPPLIER_TYPE' using errcode='P0001';
 end if;
 if p_supplier_type='one_time' and coalesce(p_default_payment_terms_days,0)<>0 then
   raise exception 'INVALID_ONE_TIME_SUPPLIER_TERMS' using errcode='P0001';
 end if;
 select supplier_type into v_old_type from public.suppliers
   where tenant_id=p_tenant_id and id=p_supplier_id for update;
 if not found then raise exception 'SUPPLIER_OUT_OF_SCOPE' using errcode='P0001'; end if;
 -- The CHECK requires zero terms for one-time suppliers. Switch to permanent before
 -- editing terms in that direction; when switching to one-time, the legacy updater
 -- writes zero terms before the type changes. All work is one transaction.
 if p_supplier_type='permanent' then
   update public.suppliers set supplier_type='permanent' where tenant_id=p_tenant_id and id=p_supplier_id;
   perform 1 from public.powerhub_inventory_update_supplier(
     p_tenant_id,p_site_id,p_user_id,p_supplier_id,p_supplier_code,p_name,p_contact_name,p_phone,p_email,
     p_address,p_tax_number,p_default_payment_terms_days,p_notes
   );
 else
   perform 1 from public.powerhub_inventory_update_supplier(
     p_tenant_id,p_site_id,p_user_id,p_supplier_id,p_supplier_code,p_name,p_contact_name,p_phone,p_email,
     p_address,p_tax_number,p_default_payment_terms_days,p_notes
   );
   update public.suppliers set supplier_type='one_time' where tenant_id=p_tenant_id and id=p_supplier_id;
 end if;
 select * into v_supplier from public.suppliers where tenant_id=p_tenant_id and id=p_supplier_id;
 select platform_role into v_platform_role from public.users where id=p_user_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data)
 values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'supplier',v_supplier.id::text,'set_supplier_type',
   jsonb_build_object('supplierType',v_old_type),jsonb_build_object('supplierType',v_supplier.supplier_type));
 return query select v_supplier.id,v_supplier.tenant_id,v_supplier.supplier_code,v_supplier.name,
   v_supplier.contact_name,v_supplier.phone,v_supplier.email,v_supplier.address,v_supplier.tax_number,
   v_supplier.default_payment_terms_days,v_supplier.supplier_type,v_supplier.notes,v_supplier.is_active,
   v_supplier.created_at,v_supplier.updated_at;
end;
$$;


drop function if exists public.powerhub_inventory_create_purchase(bigint,bigint,bigint,bigint,bigint,text,date,date,integer,text,text,text,jsonb);
drop function if exists public.powerhub_inventory_create_purchase(bigint,bigint,bigint,bigint,bigint,text,date,date,integer,text,text,text,jsonb,text);
create function public.powerhub_inventory_create_purchase(
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
  p_lines jsonb,
  p_payment_mode text default 'deferred'
)
returns table(
  purchase_id bigint, tenant_id bigint, site_id bigint, supplier_id bigint, warehouse_id bigint,
  purchase_number text, supplier_invoice_no text, invoice_date date, due_date date, payment_mode text, status text,
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
  if p_payment_mode is null or p_payment_mode not in ('immediate','deferred') then
    raise exception 'INVALID_PAYMENT_MODE' using errcode='P0001';
  end if;
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
    'payment_mode',p_payment_mode,
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
      v_purchase.due_date,v_purchase.payment_mode,v_purchase.status,v_purchase.subtotal_amount,v_purchase.discount_amount,v_purchase.tax_amount,
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

  if p_payment_mode='immediate' then
    if (p_payment_terms_days is not null and p_payment_terms_days <> 0)
      or (p_due_date is not null and p_due_date <> v_invoice_date) then
      raise exception 'INVALID_IMMEDIATE_PAYMENT_TERMS' using errcode='P0001';
    end if;
    v_terms := 0;
    v_due_date := v_invoice_date;
  else
    v_terms := coalesce(p_payment_terms_days,v_supplier.default_payment_terms_days);
    if v_terms < 0 or v_terms > 3650 then raise exception 'INVALID_PAYMENT_TERMS' using errcode='P0001'; end if;
    v_due_date := coalesce(p_due_date,v_invoice_date+v_terms);
  end if;
  if v_due_date < v_invoice_date then raise exception 'INVALID_DUE_DATE' using errcode='P0001'; end if;

  insert into public.supplier_purchases(
    tenant_id,site_id,supplier_id,warehouse_id,purchase_number,supplier_invoice_no,invoice_date,due_date,
    status,payment_mode,subtotal_amount,discount_amount,tax_amount,other_charges_amount,payment_terms_days,
    reference_no,notes,operation_key,create_payload_hash,created_by_user_id
  ) values (
    p_tenant_id,p_site_id,p_supplier_id,p_warehouse_id,
    'PUR-'||to_char(v_invoice_date,'YYYYMMDD')||'-'||lpad(nextval('public.supplier_purchase_number_seq')::text,6,'0'),
    nullif(btrim(p_supplier_invoice_no),''),v_invoice_date,v_due_date,'draft',p_payment_mode,
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
      'referenceNo',v_purchase.reference_no,'lineCount',v_line_count,'totalAmount',v_purchase.total_amount,
      'paymentMode',v_purchase.payment_mode,'status',v_purchase.status)
  );

  return query select v_purchase.id,v_purchase.tenant_id,v_purchase.site_id,v_purchase.supplier_id,
    v_purchase.warehouse_id,v_purchase.purchase_number,v_purchase.supplier_invoice_no,v_purchase.invoice_date,
    v_purchase.due_date,v_purchase.payment_mode,v_purchase.status,v_purchase.subtotal_amount,v_purchase.discount_amount,v_purchase.tax_amount,
    v_purchase.other_charges_amount,v_purchase.total_amount,v_purchase.payment_terms_days,v_purchase.operation_key,
    v_purchase.created_at,v_purchase.updated_at,false;
end;
$$;

revoke all on function public.powerhub_inventory_create_supplier_with_type(bigint,bigint,bigint,text,text,text,text,text,text,text,integer,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_inventory_create_supplier_with_type(bigint,bigint,bigint,text,text,text,text,text,text,text,integer,text,text) to service_role;
revoke all on function public.powerhub_inventory_update_supplier_with_type(bigint,bigint,bigint,bigint,text,text,text,text,text,text,text,integer,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_inventory_update_supplier_with_type(bigint,bigint,bigint,bigint,text,text,text,text,text,text,text,integer,text,text) to service_role;
revoke all on function public.powerhub_inventory_create_purchase(bigint,bigint,bigint,bigint,bigint,text,date,date,integer,text,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.powerhub_inventory_create_purchase(bigint,bigint,bigint,bigint,bigint,text,date,date,integer,text,text,text,jsonb,text) to service_role;
notify pgrst, 'reload schema';
