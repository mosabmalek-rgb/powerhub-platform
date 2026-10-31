-- Idempotent server boundary for stocktake line counts.
-- The existing 8-argument RPC remains the sole updater and audit-log writer.
-- This overload records a scoped operation receipt in the same transaction.
create table if not exists public.powerhub_inventory_stocktake_count_operations (
  tenant_id bigint not null,
  site_id bigint not null,
  user_id bigint not null,
  operation_key text not null check (length(btrim(operation_key)) between 1 and 180),
  stocktake_id bigint not null,
  item_id bigint not null,
  request_payload jsonb not null,
  result_stocktake_id bigint not null,
  result_item_id bigint not null,
  result_system_quantity numeric(14,3) not null,
  result_counted_quantity numeric(14,3) not null,
  result_variance_quantity numeric(14,3) not null,
  result_counted_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint powerhub_inventory_stocktake_count_operations_scope_key
    primary key (tenant_id,site_id,user_id,operation_key)
);
alter table public.powerhub_inventory_stocktake_count_operations owner to postgres;
alter table public.powerhub_inventory_stocktake_count_operations enable row level security;
revoke all on table public.powerhub_inventory_stocktake_count_operations from public,anon,authenticated;
grant all on table public.powerhub_inventory_stocktake_count_operations to service_role;
create index if not exists powerhub_inventory_stocktake_count_operations_session_idx
  on public.powerhub_inventory_stocktake_count_operations(tenant_id,site_id,stocktake_id,item_id,created_at);

create or replace function public.powerhub_inventory_record_stocktake_count(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_stocktake_id bigint,p_item_id bigint,
  p_counted_quantity numeric,p_counted_unit_cost numeric,p_count_notes text,p_operation_key text
)
returns table(stocktake_id bigint,item_id bigint,system_quantity numeric,counted_quantity numeric,
  variance_quantity numeric,counted_at timestamptz,replayed boolean)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_operation_key text:=nullif(btrim(p_operation_key),'');
  v_notes text:=nullif(btrim(p_count_notes),'');
  v_request_payload jsonb;
  v_existing public.powerhub_inventory_stocktake_count_operations%rowtype;
  v_result record;
begin
  if v_operation_key is null or length(v_operation_key)>180 then
    raise exception 'INVALID_OPERATION_KEY' using errcode='P0001';
  end if;
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1
    or p_user_id is null or p_user_id<1 or p_stocktake_id is null or p_stocktake_id<1
    or p_item_id is null or p_item_id<1 then
    raise exception 'INVALID_STOCKTAKE_COUNT_SCOPE' using errcode='P0001';
  end if;
  if not exists(select 1 from public.sites s where s.tenant_id=p_tenant_id and s.id=p_site_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if not exists(select 1 from public.users u where u.id=p_user_id) then
    raise exception 'ACTOR_NOT_FOUND' using errcode='P0001';
  end if;

  v_request_payload:=jsonb_build_object(
    'stocktakeId',p_stocktake_id,
    'itemId',p_item_id,
    'countedQuantity',p_counted_quantity,
    'countedUnitCost',p_counted_unit_cost,
    'countNotes',v_notes
  );

  -- Serialize only the exact tenant/site/actor/key tuple. The unique constraint
  -- remains the durable backstop if a future writer does not use this wrapper.
  perform pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array('inventory-stocktake-count',p_tenant_id,p_site_id,p_user_id,v_operation_key)::text,0
  ));

  select operation.* into v_existing
  from public.powerhub_inventory_stocktake_count_operations operation
  where operation.tenant_id=p_tenant_id
    and operation.site_id=p_site_id
    and operation.user_id=p_user_id
    and operation.operation_key=v_operation_key
  for update;

  if found then
    if v_existing.request_payload is distinct from v_request_payload then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='P0001';
    end if;
    return query select
      v_existing.result_stocktake_id,
      v_existing.result_item_id,
      v_existing.result_system_quantity,
      v_existing.result_counted_quantity,
      v_existing.result_variance_quantity,
      v_existing.result_counted_at,
      true;
    return;
  end if;

  -- Invoke the original 8-argument implementation exactly once. It owns all
  -- stocktake-line writes and the matching audit_logs insert.
  select counted.stocktake_id,counted.item_id,counted.system_quantity,counted.counted_quantity,
    counted.variance_quantity,counted.counted_at,counted.replayed
  into v_result
  from public.powerhub_inventory_record_stocktake_count(
    p_tenant_id,p_site_id,p_user_id,p_stocktake_id,p_item_id,
    p_counted_quantity,p_counted_unit_cost,v_notes
  ) counted;

  insert into public.powerhub_inventory_stocktake_count_operations(
    tenant_id,site_id,user_id,operation_key,stocktake_id,item_id,request_payload,
    result_stocktake_id,result_item_id,result_system_quantity,result_counted_quantity,
    result_variance_quantity,result_counted_at
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_operation_key,p_stocktake_id,p_item_id,v_request_payload,
    v_result.stocktake_id,v_result.item_id,v_result.system_quantity,v_result.counted_quantity,
    v_result.variance_quantity,v_result.counted_at
  );

  return query select
    v_result.stocktake_id,v_result.item_id,v_result.system_quantity,v_result.counted_quantity,
    v_result.variance_quantity,v_result.counted_at,false;
end;
$$;
alter function public.powerhub_inventory_record_stocktake_count(bigint,bigint,bigint,bigint,bigint,numeric,numeric,text,text) owner to postgres;
revoke all on function public.powerhub_inventory_record_stocktake_count(bigint,bigint,bigint,bigint,bigint,numeric,numeric,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_inventory_record_stocktake_count(bigint,bigint,bigint,bigint,bigint,numeric,numeric,text,text) to service_role;
