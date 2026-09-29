-- Field-app access is restricted to the technician role and the active technician
-- count is enforced against the editable subscription package catalog.
create or replace function public.powerhub_enforce_field_user_quota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_package_code text;
  v_limit integer;
  v_existing boolean;
  v_package jsonb;
begin
  if new.role <> 'technician' or new.is_active is not true then
    return new;
  end if;

  select coalesce(ts.package_code, t.package_code)
    into v_package_code
  from public.tenants t
  left join public.tenant_subscriptions ts on ts.tenant_id = t.id
  where t.id = new.tenant_id
  limit 1;

  select package
    into v_package
  from jsonb_array_elements(
    coalesce((select value->'packages' from public.platform_settings where setting_key = 'subscription_package_catalog' and is_enabled = true), '[]'::jsonb)
  ) package
  where package->>'code' = v_package_code
    and coalesce((package->>'active')::boolean, true) = true
  order by coalesce((package->>'fieldUsers')::integer, 0) desc
  limit 1;

  v_limit := coalesce((v_package->>'fieldUsers')::integer, 0);
  if v_limit < 0 then
    raise exception 'INVALID_FIELD_USER_QUOTA' using errcode = 'P0001';
  end if;

  select exists(
    select 1 from public.staff_profiles p
    where p.tenant_id = new.tenant_id
      and p.user_id = new.user_id
      and p.role = 'technician'
      and p.is_active = true
      and p.id <> coalesce(new.id, 0)
  ) into v_existing;

  if not v_existing and (
    select count(distinct p.user_id)
    from public.staff_profiles p
    where p.tenant_id = new.tenant_id
      and p.role = 'technician'
      and p.is_active = true
  ) >= v_limit then
    raise exception 'FIELD_USER_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists powerhub_enforce_field_user_quota on public.staff_profiles;
create trigger powerhub_enforce_field_user_quota
before insert or update of role, is_active, user_id, tenant_id on public.staff_profiles
for each row execute function public.powerhub_enforce_field_user_quota();

revoke all on function public.powerhub_enforce_field_user_quota() from public, anon, authenticated;
grant execute on function public.powerhub_enforce_field_user_quota() to service_role;
