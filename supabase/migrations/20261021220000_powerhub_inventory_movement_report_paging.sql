-- Permission-gated report query with keyset pagination and server-side filters.
-- The existing operational list RPC intentionally remains unchanged for its current callers.
create or replace function public.powerhub_inventory_list_stock_movement_report(
  p_tenant_id bigint,
  p_site_id bigint,
  p_limit integer default 101,
  p_before_occurred_at timestamptz default null,
  p_before_movement_id bigint default null,
  p_from_date date default null,
  p_to_date date default null,
  p_warehouse_id bigint default null,
  p_search text default null
)
returns table(
  movement_id bigint,
  warehouse_id bigint,
  warehouse_code text,
  warehouse_name text,
  item_id bigint,
  sku text,
  item_name text,
  base_unit text,
  generator_id bigint,
  movement_type text,
  quantity numeric,
  unit_cost numeric,
  total_cost_amount numeric,
  reference_no text,
  notes text,
  operation_key text,
  occurred_at timestamptz,
  created_by_user_id bigint,
  created_at timestamptz,
  reversal_of_movement_id bigint,
  corrects_movement_id bigint,
  correction_reason text,
  corrected_by_movement_id bigint,
  can_edit boolean,
  source_issue_movement_id bigint,
  returnable_quantity numeric
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_search text := nullif(btrim(p_search), '');
begin
  if p_tenant_id is null or p_tenant_id <= 0 or p_site_id is null or p_site_id <= 0 then
    raise exception 'INVENTORY_REPORT_SCOPE_REQUIRED' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 201 then
    raise exception 'INVALID_INVENTORY_REPORT_PAGE_SIZE' using errcode = '22023';
  end if;
  if (p_before_occurred_at is null) is distinct from (p_before_movement_id is null) then
    raise exception 'INVALID_INVENTORY_REPORT_CURSOR' using errcode = '22023';
  end if;
  if p_from_date is not null and p_to_date is not null and p_from_date > p_to_date then
    raise exception 'INVALID_INVENTORY_REPORT_DATE_RANGE' using errcode = '22023';
  end if;
  if p_warehouse_id is not null and p_warehouse_id <= 0 then
    raise exception 'INVALID_INVENTORY_REPORT_WAREHOUSE' using errcode = '22023';
  end if;
  if v_search is not null and length(v_search) > 150 then
    raise exception 'INVALID_INVENTORY_REPORT_SEARCH' using errcode = '22023';
  end if;

  return query
  select
    m.id,
    w.id,
    w.code,
    w.name,
    i.id,
    i.sku,
    i.name,
    i.base_unit,
    m.generator_id,
    m.movement_type,
    m.quantity,
    m.unit_cost,
    m.total_cost_amount,
    m.reference_no,
    m.notes,
    m.operation_key,
    m.occurred_at,
    m.created_by_user_id,
    m.created_at,
    m.reversal_of_movement_id,
    m.corrects_movement_id,
    m.correction_reason,
    (
      select c.id
      from public.inventory_stock_movements c
      where c.tenant_id = m.tenant_id and c.reversal_of_movement_id = m.id
      order by c.id desc
      limit 1
    ) as corrected_by_movement_id,
    (
      m.movement_type in ('issue','adjustment_in','adjustment_out','fuel_consumption')
      and m.purchase_id is null and m.purchase_line_id is null
      and m.reversal_of_movement_id is null and m.corrects_movement_id is null
      and not exists (
        select 1 from public.inventory_stock_movements c
        where c.tenant_id = m.tenant_id and c.reversal_of_movement_id = m.id
      )
      and not exists (
        select 1 from public.inventory_stock_movements later
        where later.tenant_id = m.tenant_id and later.site_id = m.site_id
          and later.warehouse_id = m.warehouse_id and later.item_id = m.item_id
          and later.id > m.id
      )
    ) as can_edit,
    m.source_issue_movement_id,
    case
      when m.movement_type = 'issue'
        and m.reversal_of_movement_id is null and m.corrects_movement_id is null
        and not exists (
          select 1 from public.inventory_stock_movements c
          where c.tenant_id = m.tenant_id
            and (c.reversal_of_movement_id = m.id or c.corrects_movement_id = m.id)
        )
      then greatest(
        m.quantity - coalesce((
          select sum(r.quantity)
          from public.inventory_stock_movements r
          where r.tenant_id = m.tenant_id
            and r.source_issue_movement_id = m.id
            and r.movement_type = 'return_from_issue'
        ), 0),
        0
      )
      else 0::numeric
    end as returnable_quantity
  from public.inventory_stock_movements m
  join public.inventory_items i
    on i.tenant_id = m.tenant_id and i.id = m.item_id
  join public.inventory_warehouses w
    on w.tenant_id = m.tenant_id and w.site_id = m.site_id and w.id = m.warehouse_id
  where m.tenant_id = p_tenant_id
    and m.site_id = p_site_id
    and (p_before_occurred_at is null or (m.occurred_at, m.id) < (p_before_occurred_at, p_before_movement_id))
    and (p_from_date is null or (m.occurred_at at time zone 'Asia/Hebron')::date >= p_from_date)
    and (p_to_date is null or (m.occurred_at at time zone 'Asia/Hebron')::date <= p_to_date)
    and (p_warehouse_id is null or m.warehouse_id = p_warehouse_id)
    and (
      v_search is null
      or position(lower(v_search) in lower(concat_ws(
        ' ', i.name, i.sku, w.name, w.code, m.reference_no, m.notes, m.movement_type,
        m.generator_id::text, m.id::text
      ))) > 0
    )
  order by m.occurred_at desc, m.id desc
  limit p_limit;
end;
$$;

revoke all on function public.powerhub_inventory_list_stock_movement_report(
  bigint,bigint,integer,timestamptz,bigint,date,date,bigint,text
) from public, anon, authenticated;
grant execute on function public.powerhub_inventory_list_stock_movement_report(
  bigint,bigint,integer,timestamptz,bigint,date,date,bigint,text
) to service_role;
