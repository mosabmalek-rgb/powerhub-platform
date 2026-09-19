-- PowerHub package contract hardening.
-- This migration documents the production RPC contract changes made for package_code.
-- Existing RPCs are updated in-place so package_code is authoritative and legacy plan remains compatibility-only.

do $$
declare v_sql text;
begin
  -- Field-user quota: resolve the active package by package code, never by legacyPlan alone.
  select pg_get_functiondef(p.oid) into v_sql
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='powerhub_enforce_field_user_quota' and p.prokind='f'
  order by p.oid desc limit 1;
  if v_sql is not null and v_sql like '%v_package_code%' then
    v_sql:=replace(v_sql,
      $a$where package->>'legacyPlan' = v_plan$a$,
      $b$where package->>'code' = coalesce(v_package_code,
        case v_plan when 'starter' then 'basic' when 'professional' then 'advanced' when 'enterprise' then 'business' end)
        and coalesce((package->>'active')::boolean, true) = true$b$);
    execute v_sql;
  end if;

  -- Staff quota: package-aware limits are already enforced in the current production definition.
  -- Keep this assertion executable during migration to prevent silent regression.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='powerhub_assign_existing_staff'
      and pg_get_functiondef(p.oid) like '%v_package_code%'
      and pg_get_functiondef(p.oid) like '%basic%2%'
  ) then
    raise exception 'PACKAGE_CONTRACT_REGRESSION: powerhub_assign_existing_staff is not package-aware';
  end if;
end $$;
