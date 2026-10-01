-- Add an atomic tariff update path for tenant operators.
-- Historical invoices keep their own price_per_kwh snapshot; the tariff row's
-- effective_from is advanced so newly issued invoices pick up the new price.

create or replace function public.powerhub_update_tariff(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_tariff_id bigint,
  p_name text,
  p_price_per_kwh numeric,
  p_fixed_fee numeric default 0,
  p_tax_rate numeric default 0
)
returns table(tariff_id bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user public.users%rowtype;
  v_tenant_role text;
  v_staff_role text;
  v_has_permission boolean := false;
  v_before public.tariffs%rowtype;
  v_after public.tariffs%rowtype;
  v_platform_role text;
begin
  if p_name is null or char_length(btrim(p_name)) < 2 then
    raise exception 'INVALID_TARIFF_NAME' using errcode='P0001';
  end if;
  if p_price_per_kwh < 0 or p_fixed_fee < 0 or p_tax_rate < 0 or p_tax_rate > 100 then
    raise exception 'INVALID_TARIFF_VALUES' using errcode='P0001';
  end if;

  select * into v_user
  from public.users u
  where u.id=p_user_id and u.account_status='active'
  limit 1;

  if not found then
    raise exception 'AUTH_USER_NOT_FOUND' using errcode='P0001';
  end if;

  if v_user.role='admin'
     and v_user.platform_role in ('platform_owner','platform_admin')
  then
    v_has_permission := true;
  else
    select tm.role into v_tenant_role
    from public.tenant_members tm
    where tm.tenant_id=p_tenant_id
      and tm.user_id=p_user_id
      and tm.role='owner'
      and tm.is_active=true
      and tm.membership_status='active'
    limit 1;

    if v_tenant_role='owner' then
      v_has_permission := true;
    else
      select sp.role, (sp.permissions @> '["manageTariffs"]'::jsonb)
      into v_staff_role, v_has_permission
      from public.staff_profiles sp
      where sp.tenant_id=p_tenant_id
        and sp.user_id=p_user_id
        and sp.is_active=true
        and (sp.site_id=p_site_id or sp.site_id is null)
      order by case when sp.site_id=p_site_id then 0 else 1 end
      limit 1;

      if not coalesce(v_has_permission,false) then
        v_has_permission := v_staff_role in ('owner','manager','accountant');
      end if;
    end if;
  end if;

  if not v_has_permission then
    raise exception 'TARIFF_MANAGEMENT_FORBIDDEN' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(p_tenant_id, hashtext(format('tariff-update:%s', p_site_id)));

  select * into v_before
  from public.tariffs t
  where t.id=p_tariff_id
    and t.tenant_id=p_tenant_id
    and t.site_id=p_site_id
  for update;

  if not found then
    raise exception 'TARIFF_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  update public.tariffs
  set name=btrim(p_name),
      price_per_kwh=p_price_per_kwh,
      fixed_fee=p_fixed_fee,
      tax_rate=p_tax_rate,
      is_active=true,
      effective_from=clock_timestamp()
  where id=p_tariff_id
    and tenant_id=p_tenant_id
    and site_id=p_site_id
  returning * into v_after;

  select platform_role into v_platform_role
  from public.users
  where id=p_user_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,
    'tariff',p_tariff_id::text,'update',
    jsonb_build_object(
      'name',v_before.name,
      'code',v_before.code,
      'pricePerKwh',v_before.price_per_kwh,
      'fixedFee',v_before.fixed_fee,
      'taxRate',v_before.tax_rate,
      'effectiveFrom',v_before.effective_from
    ),
    jsonb_build_object(
      'name',v_after.name,
      'code',v_after.code,
      'pricePerKwh',v_after.price_per_kwh,
      'fixedFee',v_after.fixed_fee,
      'taxRate',v_after.tax_rate,
      'effectiveFrom',v_after.effective_from
    )
  );

  return query select v_after.id;
end;
$function$;

revoke execute on function public.powerhub_update_tariff(bigint,bigint,bigint,bigint,text,numeric,numeric,numeric) from public, anon, authenticated;
grant execute on function public.powerhub_update_tariff(bigint,bigint,bigint,bigint,text,numeric,numeric,numeric) to service_role;