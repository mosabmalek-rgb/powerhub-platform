-- Enforce catalog limits for owner-requested add-ons.
-- In the current catalog subscribers50 is a 50-subscriber bundle with maxBundles=2.
create or replace function public.powerhub_request_tenant_addon(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_addon_code text,
  p_quantity integer default 1,
  p_note text default null
)
returns table(request_id bigint, addon_code text, quantity integer, already_requested boolean)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_existing_id bigint;
  v_existing_qty integer;
  v_catalog jsonb;
  v_addon jsonb;
  v_active_qty integer:=0;
  v_pending_qty integer:=0;
  v_max_bundles integer;
begin
  if p_addon_code not in ('fieldUser','platformUser','subscribers50','branch','sms') then
    raise exception 'INVALID_ADDON_CODE' using errcode='P0001';
  end if;
  if p_quantity is null or p_quantity<1 or p_quantity>1000 then
    raise exception 'INVALID_ADDON_QUANTITY' using errcode='P0001';
  end if;

  if not exists(
    select 1 from public.tenant_members
    where tenant_id=p_tenant_id and user_id=p_user_id
      and role='owner' and is_active=true and membership_status='active'
  ) then
    raise exception 'ADDON_REQUEST_OWNER_ONLY' using errcode='42501';
  end if;

  if p_site_id is not null and not exists(
    select 1 from public.sites
    where id=p_site_id and tenant_id=p_tenant_id and status<>'archived'
  ) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  select value into v_catalog
  from public.platform_settings
  where setting_key='subscription_package_catalog' and is_enabled=true;

  select pkg->'addons'->p_addon_code
    into v_addon
  from jsonb_array_elements(coalesce(v_catalog->'packages','[]'::jsonb)) pkg
  limit 1;

  if v_addon is null or jsonb_typeof(v_addon) <> 'object' then
    v_addon:=coalesce(v_catalog->'addons'->p_addon_code,'{}'::jsonb);
  end if;

  if p_addon_code='subscribers50' then
    v_max_bundles:=case
      when (v_catalog->'addons'->'subscribers50'->>'maxBundles') ~ '^[0-9]+$'
        then (v_catalog->'addons'->'subscribers50'->>'maxBundles')::int
      else 2
    end;

    select coalesce(sum(quantity),0)::int into v_active_qty
    from public.tenant_addon_requests
    where tenant_id=p_tenant_id and addon_code='subscribers50'
      and status='approved'
      and (starts_at is null or starts_at<=now())
      and (ends_at is null or ends_at>now());

    select coalesce(sum(quantity),0)::int into v_pending_qty
    from public.tenant_addon_requests
    where tenant_id=p_tenant_id and addon_code='subscribers50'
      and status in ('pending','reviewing');

    if v_active_qty + v_pending_qty + p_quantity > greatest(0,coalesce(v_max_bundles,2)) then
      raise exception 'ADDON_MAX_REACHED' using errcode='P0001';
    end if;
  end if;

  select id,quantity
    into v_existing_id,v_existing_qty
  from public.tenant_addon_requests
  where tenant_id=p_tenant_id
    and addon_code=p_addon_code
    and status in ('pending','reviewing')
  order by created_at desc
  limit 1
  for update;

  if found then
    return query select v_existing_id,p_addon_code,v_existing_qty,true;
    return;
  end if;

  insert into public.tenant_addon_requests(
    tenant_id,site_id,requested_by_user_id,addon_code,quantity,note
  )
  values(p_tenant_id,p_site_id,p_user_id,p_addon_code,p_quantity,p_note)
  returning id into v_existing_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,entity_type,entity_id,action,after_data
  )
  values(
    p_tenant_id,p_site_id,p_user_id,'tenant_addon_request',v_existing_id::text,
    'request_addon',
    jsonb_build_object('addonCode',p_addon_code,'quantity',p_quantity,'note',p_note)
  );

  return query select v_existing_id,p_addon_code,p_quantity,false;
end;
$$;

revoke execute on function public.powerhub_request_tenant_addon(bigint,bigint,bigint,text,integer,text) from public,anon,authenticated;
grant execute on function public.powerhub_request_tenant_addon(bigint,bigint,bigint,text,integer,text) to service_role;
