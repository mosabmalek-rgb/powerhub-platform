-- The shared audit_logs table stores operation-specific details in metadata JSONB;
-- there is no standalone reason column. Preserve the reason without schema drift.
create or replace function public.powerhub_inventory_set_item_unit_active(
  p_tenant_id bigint,
  p_site_id bigint,
  p_item_id bigint,
  p_unit_id bigint,
  p_user_id bigint,
  p_is_active boolean,
  p_reason text default null
)
returns table(
  id bigint,tenant_id bigint,item_id bigint,unit_label text,factor_to_base numeric,
  is_active boolean,created_at timestamptz,updated_at timestamptz
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_unit public.inventory_item_units%rowtype;
  v_before jsonb;
  v_platform_role text;
  v_reason text:=nullif(btrim(p_reason),'');
begin
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  select u.* into v_unit from public.inventory_item_units u
    where u.tenant_id=p_tenant_id and u.item_id=p_item_id and u.id=p_unit_id
    for update;
  if not found then raise exception 'INVENTORY_ITEM_UNIT_NOT_FOUND' using errcode='P0001'; end if;
  if p_is_active is null then raise exception 'INVALID_ACTIVE_STATE' using errcode='P0001'; end if;
  if not p_is_active and (v_reason is null or length(v_reason)<3) then
    raise exception 'INVENTORY_DEACTIVATION_REASON_REQUIRED' using errcode='P0001';
  end if;
  if v_unit.is_active=p_is_active then
    return query select v_unit.id,v_unit.tenant_id,v_unit.item_id,v_unit.unit_label,
      v_unit.factor_to_base,v_unit.is_active,v_unit.created_at,v_unit.updated_at;
    return;
  end if;
  if not p_is_active and exists(
    select 1 from public.supplier_purchase_lines pl
    join public.supplier_purchases p on p.tenant_id=pl.tenant_id and p.id=pl.purchase_id
    where pl.tenant_id=p_tenant_id and pl.item_id=p_item_id
      and lower(btrim(pl.unit))=lower(btrim(v_unit.unit_label))
      and pl.received_quantity<pl.quantity and p.status in ('draft','confirmed','partially_received')
  ) then
    raise exception 'INVENTORY_ITEM_UNIT_HAS_OPEN_PURCHASE' using errcode='P0001';
  end if;

  v_before:=jsonb_build_object('itemId',v_unit.item_id,'unitLabel',v_unit.unit_label,
    'factorToBase',v_unit.factor_to_base,'isActive',v_unit.is_active);
  select u.platform_role into v_platform_role
    from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  update public.inventory_item_units u set is_active=p_is_active,updated_at=now()
    where u.tenant_id=p_tenant_id and u.item_id=p_item_id and u.id=p_unit_id
    returning * into v_unit;
  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_item_unit',v_unit.id::text,
    case when p_is_active then 'reactivate' else 'deactivate' end,v_before,
    jsonb_build_object('itemId',v_unit.item_id,'unitLabel',v_unit.unit_label,
      'factorToBase',v_unit.factor_to_base,'isActive',v_unit.is_active),jsonb_build_object('reason',v_reason)
  );
  return query select v_unit.id,v_unit.tenant_id,v_unit.item_id,v_unit.unit_label,
    v_unit.factor_to_base,v_unit.is_active,v_unit.created_at,v_unit.updated_at;
end;
$$;
