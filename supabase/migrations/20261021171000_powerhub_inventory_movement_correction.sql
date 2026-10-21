-- Append-only, audited corrections for manual inventory movements.
alter table public.inventory_stock_movements
  add column if not exists reversal_of_movement_id bigint,
  add column if not exists corrects_movement_id bigint,
  add column if not exists correction_reason text;
do $constraints$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.inventory_stock_movements'::regclass and conname='inventory_stock_movements_reversal_tenant_fk') then
    alter table public.inventory_stock_movements add constraint inventory_stock_movements_reversal_tenant_fk
      foreign key(tenant_id,reversal_of_movement_id) references public.inventory_stock_movements(tenant_id,id) on delete restrict;
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.inventory_stock_movements'::regclass and conname='inventory_stock_movements_corrects_tenant_fk') then
    alter table public.inventory_stock_movements add constraint inventory_stock_movements_corrects_tenant_fk
      foreign key(tenant_id,corrects_movement_id) references public.inventory_stock_movements(tenant_id,id) on delete restrict;
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.inventory_stock_movements'::regclass and conname='inventory_stock_movements_correction_reason_ck') then
    alter table public.inventory_stock_movements add constraint inventory_stock_movements_correction_reason_ck
      check(correction_reason is null or length(trim(correction_reason)) between 3 and 500);
  end if;
end;
$constraints$;
create unique index if not exists inventory_stock_movements_reversal_unique_idx
  on public.inventory_stock_movements(tenant_id,reversal_of_movement_id) where reversal_of_movement_id is not null;
create unique index if not exists inventory_stock_movements_corrects_unique_idx
  on public.inventory_stock_movements(tenant_id,corrects_movement_id) where corrects_movement_id is not null;

create or replace function public.powerhub_inventory_reject_stock_movement_mutation()
returns trigger language plpgsql security invoker set search_path=public,pg_temp
as $$
begin
  raise exception 'INVENTORY_STOCK_MOVEMENT_IMMUTABLE'
    using errcode='P0001',detail=format('operation=%s movement_id=%s',tg_op,old.id);
end;
$$;
revoke all on function public.powerhub_inventory_reject_stock_movement_mutation() from public,anon,authenticated;
grant execute on function public.powerhub_inventory_reject_stock_movement_mutation() to service_role;
drop trigger if exists inventory_stock_movement_append_only on public.inventory_stock_movements;
create trigger inventory_stock_movement_append_only before update or delete on public.inventory_stock_movements
for each row execute function public.powerhub_inventory_reject_stock_movement_mutation();


drop function if exists public.powerhub_inventory_list_stock_movements(bigint,bigint,integer);
create function public.powerhub_inventory_list_stock_movements(
  p_tenant_id bigint,p_site_id bigint,p_limit integer default 100
)
returns table(
  movement_id bigint,warehouse_id bigint,warehouse_code text,warehouse_name text,
  item_id bigint,sku text,item_name text,base_unit text,generator_id bigint,movement_type text,
  quantity numeric,unit_cost numeric,total_cost_amount numeric,reference_no text,notes text,
  operation_key text,occurred_at timestamptz,created_by_user_id bigint,created_at timestamptz,
  reversal_of_movement_id bigint,corrects_movement_id bigint,correction_reason text,
  corrected_by_movement_id bigint,can_edit boolean
)
language sql stable security invoker set search_path=public,pg_temp
as $$
  select m.id,w.id,w.code,w.name,i.id,i.sku,i.name,i.base_unit,m.generator_id,m.movement_type,
    m.quantity,m.unit_cost,m.total_cost_amount,m.reference_no,m.notes,m.operation_key,m.occurred_at,
    m.created_by_user_id,m.created_at,m.reversal_of_movement_id,m.corrects_movement_id,m.correction_reason,
    (select c.id from public.inventory_stock_movements c
      where c.tenant_id=m.tenant_id and c.reversal_of_movement_id=m.id order by c.id desc limit 1),
    (
      m.movement_type in ('issue','adjustment_in','adjustment_out','fuel_consumption')
      and m.purchase_id is null and m.purchase_line_id is null
      and m.reversal_of_movement_id is null
      and not exists(select 1 from public.inventory_stock_movements c
        where c.tenant_id=m.tenant_id and c.reversal_of_movement_id=m.id)
      and not exists(select 1 from public.inventory_stock_movements later
        where later.tenant_id=m.tenant_id and later.site_id=m.site_id
          and later.warehouse_id=m.warehouse_id and later.item_id=m.item_id and later.id>m.id)
    )
  from public.inventory_stock_movements m
  join public.inventory_items i on i.tenant_id=m.tenant_id and i.id=m.item_id
  join public.inventory_warehouses w on w.tenant_id=m.tenant_id and w.site_id=m.site_id and w.id=m.warehouse_id
  where m.tenant_id=p_tenant_id and m.site_id=p_site_id
  order by m.occurred_at desc,m.id desc limit greatest(1,least(coalesce(p_limit,100),500));
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
  v_prior_cost numeric(14,2);
  v_cumulative_cost numeric(14,2);
  v_receipt_total_cost numeric(14,2);
  v_received_after numeric(14,3);
  v_receipt_cost_total numeric(14,2):=0;
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

    perform pg_advisory_xact_lock(hashtextextended(
      p_tenant_id::text||':inventory-stock:'||v_purchase.warehouse_id::text||':'||v_purchase_line.item_id::text,0
    ));

    v_base_quantity := round(v_line.quantity*v_purchase_line.units_to_base_factor,3);
    if v_base_quantity <= 0 then raise exception 'INVALID_RECEIPT_LINES' using errcode='P0001'; end if;

    -- Allocate invoice cents cumulatively. The final receipt receives the exact residual,
    -- so splitting a line across multiple receipts cannot create or lose currency cents.
    v_received_after := v_purchase_line.received_quantity + v_line.quantity;
    v_cumulative_cost := round(
      v_purchase_line.line_total * v_received_after / v_purchase_line.quantity,2
    );
    select coalesce(sum(m.total_cost_amount),0)::numeric(14,2)
      into v_prior_cost
    from public.inventory_stock_movements m
    where m.tenant_id=p_tenant_id
      and m.purchase_line_id=v_purchase_line.id
      and m.movement_type='purchase_receipt';

    v_receipt_total_cost := v_cumulative_cost - v_prior_cost;
    if v_receipt_total_cost<0 then
      raise exception 'PURCHASE_RECEIPT_COST_RECONCILIATION_FAILED'
        using errcode='P0001',
          detail=format('purchase_line_id=%s cumulative_cost=%s prior_cost=%s',
            v_purchase_line.id,v_cumulative_cost,v_prior_cost);
    end if;
    v_unit_cost := case when v_base_quantity>0
      then round(v_receipt_total_cost/v_base_quantity,4)
      else 0::numeric end;
    v_receipt_cost_total := v_receipt_cost_total + v_receipt_total_cost;

    insert into public.inventory_stock_movements(
      tenant_id,site_id,warehouse_id,item_id,movement_type,quantity,unit_cost,total_cost_amount,
      purchase_id,purchase_line_id,reference_no,notes,operation_key,occurred_at,created_by_user_id
    ) values (
      p_tenant_id,p_site_id,v_purchase.warehouse_id,v_purchase_line.item_id,'purchase_receipt',
      v_base_quantity,v_unit_cost,v_receipt_total_cost,v_purchase.id,v_purchase_line.id,
      v_receipt.receipt_number,nullif(btrim(p_notes),''),
      'purchase-receipt:'||v_receipt.id||':line:'||v_purchase_line.id,
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
      'purchaseNumber',v_purchase.purchase_number,'purchaseStatus',v_purchase.status,'lineCount',v_line_count,
      'inventoryCostAmount',v_receipt_cost_total),
    jsonb_build_object('operationKey',v_receipt.operation_key,'inventoryCostAmount',v_receipt_cost_total)
  );

  return query select v_receipt.id,v_receipt.receipt_number,v_purchase.id,v_purchase.purchase_number,
    v_purchase.status,v_receipt.received_at,false;
end;
$$;
revoke execute on function public.powerhub_inventory_receive_purchase(bigint,bigint,bigint,bigint,date,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.powerhub_inventory_receive_purchase(bigint,bigint,bigint,bigint,date,text,text,jsonb) to service_role;

create or replace function public.powerhub_inventory_correct_stock_movement(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_movement_id bigint,
  p_quantity numeric,p_unit_cost numeric,p_reference_no text,p_notes text,p_reason text,p_operation_key text
)
returns table(
  original_movement_id bigint,reversal_movement_id bigint,replacement_movement_id bigint,
  movement_type text,quantity numeric,unit_cost numeric,total_cost_amount numeric,
  on_hand_quantity numeric,stock_value numeric,replayed boolean
)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare
  v_original public.inventory_stock_movements%rowtype;
  v_reversal public.inventory_stock_movements%rowtype;
  v_replacement public.inventory_stock_movements%rowtype;
  v_operation_key text:=nullif(btrim(p_operation_key),'');
  v_reversal_key text;
  v_replacement_key text;
  v_reason text:=nullif(btrim(p_reason),'');
  v_reference_no text:=nullif(btrim(p_reference_no),'');
  v_notes text:=nullif(btrim(p_notes),'');
  v_payload_hash text;
  v_platform_role text;
  v_item_category text;
  v_original_sign integer;
  v_reverse_type text;
  v_current_quantity numeric(14,3);
  v_current_value numeric(14,2);
  v_quantity_without_original numeric(14,3);
  v_value_without_original numeric(14,2);
  v_new_unit_cost numeric(14,4);
  v_new_total_cost numeric(14,2);
  v_final_quantity numeric(14,3);
  v_final_value numeric(14,2);
begin
  if v_operation_key is null or length(v_operation_key)>160 then
    raise exception 'INVALID_OPERATION_KEY' using errcode='P0001';
  end if;
  if p_movement_id is null or p_movement_id<=0 then
    raise exception 'STOCK_MOVEMENT_NOT_FOUND' using errcode='P0001';
  end if;
  if p_quantity is null or p_quantity<=0 or p_quantity>1000000000 or p_quantity*1000<>trunc(p_quantity*1000) then
    raise exception 'INVALID_STOCK_QUANTITY' using errcode='P0001';
  end if;
  if p_unit_cost is not null and (
    p_unit_cost<0 or p_unit_cost>1000000000 or p_unit_cost*10000<>trunc(p_unit_cost*10000)
  ) then raise exception 'INVALID_STOCK_UNIT_COST' using errcode='P0001'; end if;
  if p_reference_no is not null and length(p_reference_no)>120 then raise exception 'INVALID_STOCK_REFERENCE' using errcode='P0001'; end if;
  if p_notes is not null and length(p_notes)>2000 then raise exception 'INVALID_STOCK_NOTES' using errcode='P0001'; end if;
  if v_reason is null or length(v_reason) not between 3 and 500 then
    raise exception 'STOCK_MOVEMENT_CORRECTION_REASON_REQUIRED' using errcode='P0001';
  end if;

  v_reversal_key:=v_operation_key||':reversal';
  v_replacement_key:=v_operation_key||':replacement';
  v_payload_hash:=md5(jsonb_build_object('site_id',p_site_id,'movement_id',p_movement_id,
    'quantity',round(p_quantity,3),
    'unit_cost',case when p_unit_cost is null then null else round(p_unit_cost,4) end,
    'reference_no',v_reference_no,'notes',v_notes,'reason',v_reason)::text);
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':inventory-stock-correction:'||v_operation_key,0));

  select m.* into v_replacement from public.inventory_stock_movements m
  where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.operation_key=v_replacement_key for update;
  if found then
    if v_replacement.operation_payload_hash is distinct from v_payload_hash or v_replacement.corrects_movement_id is null then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='P0001';
    end if;
    select m.* into v_reversal from public.inventory_stock_movements m
    where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.operation_key=v_reversal_key
      and m.reversal_of_movement_id=v_replacement.corrects_movement_id;
    if not found then raise exception 'STOCK_MOVEMENT_CORRECTION_INCOMPLETE' using errcode='P0001'; end if;
    select coalesce(sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
      then m.quantity else -m.quantity end),0)::numeric(14,3),
      coalesce(sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
      then m.total_cost_amount else -m.total_cost_amount end),0)::numeric(14,2)
    into v_current_quantity,v_current_value
    from public.inventory_stock_movements m
    where m.tenant_id=p_tenant_id and m.site_id=p_site_id
      and m.warehouse_id=v_replacement.warehouse_id and m.item_id=v_replacement.item_id;
    return query select v_replacement.corrects_movement_id,v_reversal.id,v_replacement.id,
      v_replacement.movement_type,v_replacement.quantity,v_replacement.unit_cost,v_replacement.total_cost_amount,
      v_current_quantity,greatest(v_current_value,0)::numeric(14,2),true;
    return;
  end if;

  select m.* into v_original from public.inventory_stock_movements m
  where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.id=p_movement_id for update;
  if not found then raise exception 'STOCK_MOVEMENT_NOT_FOUND' using errcode='P0001'; end if;
  if v_original.movement_type not in ('issue','adjustment_in','adjustment_out','fuel_consumption')
    or v_original.purchase_id is not null or v_original.purchase_line_id is not null
    or v_original.reversal_of_movement_id is not null then
    raise exception 'STOCK_MOVEMENT_NOT_EDITABLE' using errcode='P0001';
  end if;
  if exists(select 1 from public.inventory_stock_movements c
    where c.tenant_id=p_tenant_id and c.reversal_of_movement_id=v_original.id) then
    raise exception 'STOCK_MOVEMENT_ALREADY_CORRECTED' using errcode='P0001';
  end if;
  if v_original.movement_type<>'adjustment_in' and p_unit_cost is not null then
    raise exception 'INVALID_STOCK_UNIT_COST' using errcode='P0001';
  end if;
  select i.category into v_item_category from public.inventory_items i
  where i.tenant_id=p_tenant_id and i.id=v_original.item_id and i.is_active=true;
  if not found then raise exception 'STOCK_ITEM_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if not exists(select 1 from public.inventory_warehouses w
    where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=v_original.warehouse_id and w.is_active=true) then
    raise exception 'STOCK_WAREHOUSE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if v_original.movement_type='fuel_consumption' and (
    v_original.generator_id is null or v_item_category<>'fuel'
    or not exists(select 1 from public.generators g
      where g.id=v_original.generator_id and g.tenant_id=p_tenant_id and g.site_id=p_site_id)
  ) then raise exception 'FUEL_MOVEMENT_SCOPE_INVALID' using errcode='P0001'; end if;
  select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':inventory-stock:'||v_original.warehouse_id::text||':'||v_original.item_id::text,0
  ));
  if exists(select 1 from public.inventory_stock_movements later
    where later.tenant_id=p_tenant_id and later.site_id=p_site_id and later.warehouse_id=v_original.warehouse_id
      and later.item_id=v_original.item_id and later.id>v_original.id) then
    raise exception 'STOCK_MOVEMENT_NOT_LATEST' using errcode='P0001';
  end if;
  if exists(select 1 from public.financial_settlements fs
    where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked'
      and ((fs.period_start<=now() and fs.period_end>=now())
        or (fs.period_start::date<=v_original.occurred_at::date and fs.period_end::date>=v_original.occurred_at::date))) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;

  v_original_sign:=case when v_original.movement_type='adjustment_in' then 1 else -1 end;
  v_reverse_type:=case when v_original_sign=1 then 'adjustment_out' else 'adjustment_in' end;
  select coalesce(sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
      then m.quantity else -m.quantity end),0)::numeric(14,3),
    coalesce(sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
      then m.total_cost_amount else -m.total_cost_amount end),0)::numeric(14,2)
  into v_current_quantity,v_current_value
  from public.inventory_stock_movements m
  where m.tenant_id=p_tenant_id and m.site_id=p_site_id
    and m.warehouse_id=v_original.warehouse_id and m.item_id=v_original.item_id;
  v_quantity_without_original:=v_current_quantity-(v_original_sign*v_original.quantity);
  v_value_without_original:=v_current_value-(v_original_sign*v_original.total_cost_amount);
  if v_quantity_without_original<0 or v_value_without_original<0 then
    raise exception 'STOCK_MOVEMENT_CORRECTION_WOULD_NEGATE_BALANCE' using errcode='P0001';
  end if;

  if v_original.movement_type='adjustment_in' then
    if p_unit_cost is not null then
      v_new_unit_cost:=round(p_unit_cost,4);
      v_new_total_cost:=round(p_quantity*v_new_unit_cost,2);
    else
      if v_quantity_without_original<=0 then raise exception 'STOCK_UNIT_COST_REQUIRED' using errcode='P0001'; end if;
      v_new_unit_cost:=round(v_value_without_original/v_quantity_without_original,4);
      v_new_total_cost:=round(p_quantity*v_new_unit_cost,2);
    end if;
  else
    if p_quantity>v_quantity_without_original then raise exception 'INSUFFICIENT_STOCK' using errcode='P0001'; end if;
    v_new_unit_cost:=case when v_quantity_without_original>0
      then round(v_value_without_original/v_quantity_without_original,4) else 0::numeric end;
    if p_quantity=v_quantity_without_original then
      v_new_total_cost:=v_value_without_original;
      v_new_unit_cost:=round(v_new_total_cost/p_quantity,4);
    else v_new_total_cost:=round(p_quantity*v_new_unit_cost,2);
    end if;
  end if;

  v_final_quantity:=v_quantity_without_original+(v_original_sign*p_quantity);
  v_final_value:=v_value_without_original+(v_original_sign*v_new_total_cost);
  if v_final_quantity<0 then raise exception 'INSUFFICIENT_STOCK' using errcode='P0001'; end if;
  if v_final_value<0 then raise exception 'STOCK_MOVEMENT_CORRECTION_COST_NEGATIVE' using errcode='P0001'; end if;

  insert into public.inventory_stock_movements(
    tenant_id,site_id,warehouse_id,item_id,generator_id,movement_type,quantity,unit_cost,total_cost_amount,
    reference_no,notes,operation_key,operation_payload_hash,occurred_at,created_by_user_id,
    reversal_of_movement_id,corrects_movement_id,correction_reason
  ) values (
    p_tenant_id,p_site_id,v_original.warehouse_id,v_original.item_id,v_original.generator_id,
    v_reverse_type,v_original.quantity,v_original.unit_cost,v_original.total_cost_amount,
    coalesce(v_original.reference_no,'CORR-'||v_original.id::text),
    'عكس الحركة #'||v_original.id::text||' — '||v_reason,
    v_reversal_key,md5(jsonb_build_object('reverses',v_original.id,'payloadHash',v_payload_hash)::text),
    now(),p_user_id,v_original.id,null,v_reason
  ) returning * into v_reversal;

  insert into public.inventory_stock_movements(
    tenant_id,site_id,warehouse_id,item_id,generator_id,movement_type,quantity,unit_cost,total_cost_amount,
    reference_no,notes,operation_key,operation_payload_hash,occurred_at,created_by_user_id,
    reversal_of_movement_id,corrects_movement_id,correction_reason
  ) values (
    p_tenant_id,p_site_id,v_original.warehouse_id,v_original.item_id,v_original.generator_id,
    v_original.movement_type,round(p_quantity,3),v_new_unit_cost,v_new_total_cost,
    v_reference_no,coalesce(v_notes,v_reason),v_replacement_key,v_payload_hash,
    now(),p_user_id,null,v_original.id,v_reason
  ) returning * into v_replacement;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_stock_movement',v_reversal.id::text,'reverse_for_correction',
    jsonb_build_object('movementId',v_original.id,'movementType',v_original.movement_type,
      'quantity',v_original.quantity,'unitCost',v_original.unit_cost,'totalCostAmount',v_original.total_cost_amount),
    jsonb_build_object('movementId',v_reversal.id,'movementType',v_reversal.movement_type,
      'quantity',v_reversal.quantity,'unitCost',v_reversal.unit_cost,'totalCostAmount',v_reversal.total_cost_amount),
    jsonb_build_object('operationKey',v_operation_key,'reason',v_reason,'replacementMovementId',v_replacement.id)
  );
  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_stock_movement',v_replacement.id::text,'correct_movement',
    jsonb_build_object('movementId',v_original.id,'movementType',v_original.movement_type,
      'quantity',v_original.quantity,'unitCost',v_original.unit_cost,'totalCostAmount',v_original.total_cost_amount,
      'referenceNo',v_original.reference_no,'notes',v_original.notes),
    jsonb_build_object('movementId',v_replacement.id,'movementType',v_replacement.movement_type,
      'quantity',v_replacement.quantity,'unitCost',v_replacement.unit_cost,'totalCostAmount',v_replacement.total_cost_amount,
      'referenceNo',v_replacement.reference_no,'notes',v_replacement.notes),
    jsonb_build_object('operationKey',v_operation_key,'reason',v_reason,'reversalMovementId',v_reversal.id)
  );
  return query select v_original.id,v_reversal.id,v_replacement.id,v_replacement.movement_type,
    v_replacement.quantity,v_replacement.unit_cost,v_replacement.total_cost_amount,
    v_final_quantity,greatest(v_final_value,0)::numeric(14,2),false;
end;
$$;

revoke all on function public.powerhub_inventory_correct_stock_movement(bigint,bigint,bigint,bigint,numeric,numeric,text,text,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_inventory_correct_stock_movement(bigint,bigint,bigint,bigint,numeric,numeric,text,text,text,text) to service_role;
revoke all on function public.powerhub_inventory_list_stock_movements(bigint,bigint,integer) from public,anon,authenticated;
grant execute on function public.powerhub_inventory_list_stock_movements(bigint,bigint,integer) to service_role;
