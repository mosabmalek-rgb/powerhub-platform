-- Preserve exact invoice-line value across partial receipt boundaries.
-- Stock movements stay append-only; the cost amount is authoritative while unit_cost remains
-- the rounded unit-rate used for operational display and average-cost calculations.

alter table public.inventory_stock_movements
  alter column total_cost_amount drop expression;

alter table public.inventory_stock_movements
  alter column total_cost_amount set not null;

do $cost_constraint$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.inventory_stock_movements'::regclass
      and conname='inventory_stock_movements_total_cost_nonnegative_ck'
  ) then
    alter table public.inventory_stock_movements
      add constraint inventory_stock_movements_total_cost_nonnegative_ck
      check (total_cost_amount >= 0) not valid;
  end if;
end;
$cost_constraint$;

alter table public.inventory_stock_movements
  validate constraint inventory_stock_movements_total_cost_nonnegative_ck;

create or replace function public.powerhub_inventory_default_stock_movement_cost()
returns trigger
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
begin
  if new.total_cost_amount is null then
    new.total_cost_amount := round(new.quantity * new.unit_cost,2);
  end if;
  if new.total_cost_amount < 0 then
    raise exception 'INVALID_STOCK_MOVEMENT_TOTAL_COST' using errcode='P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.powerhub_inventory_default_stock_movement_cost() from public,anon,authenticated;
grant execute on function public.powerhub_inventory_default_stock_movement_cost() to service_role;

drop trigger if exists inventory_stock_movement_default_cost on public.inventory_stock_movements;
create trigger inventory_stock_movement_default_cost
before insert on public.inventory_stock_movements
for each row execute function public.powerhub_inventory_default_stock_movement_cost();

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
