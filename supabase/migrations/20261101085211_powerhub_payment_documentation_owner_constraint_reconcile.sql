-- Normalize the Staging entitlement constraint name to the Production contract.
-- The existing unique constraint/index is renamed in place; no entitlement rows are changed.
do $constraint_name$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_feature_entitlements'::regclass
      and conname = 'tenant_feature_entitlements_tenant_id_feature_key_key'
  ) and exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_feature_entitlements'::regclass
      and conname = 'tenant_feature_entitlements_tenant_feature_key'
  ) then
    alter table public.tenant_feature_entitlements
      rename constraint tenant_feature_entitlements_tenant_feature_key
      to tenant_feature_entitlements_tenant_id_feature_key_key;
  end if;
end;
$constraint_name$;

create or replace function public.powerhub_owner_set_payment_documentation(
  p_user_id bigint,
  p_site_id bigint,
  p_is_enabled boolean
)
returns table(success boolean, tenant_id bigint, feature_key text, is_enabled boolean, policy text)
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_tenant_id bigint;
  v_access record;
  v_global_enabled boolean := false;
  v_admin_status text;
  v_now timestamptz := now();
begin
  select s.tenant_id into v_tenant_id
  from public.sites s
  join public.tenant_members tm
    on tm.tenant_id = s.tenant_id
   and tm.user_id = p_user_id
   and tm.role = 'owner'
   and tm.is_active = true
   and tm.membership_status = 'active'
  join public.tenants t on t.id = s.tenant_id
  where s.id = p_site_id
    and s.status = 'active'
    and t.status = 'active'
  limit 1;

  if v_tenant_id is null then
    raise exception 'OWNER_SITE_FORBIDDEN' using errcode = 'P0001';
  end if;

  select coalesce(fc.is_active, false) into v_global_enabled
  from public.feature_catalog fc
  where fc.feature_key = 'payment_documentation'
  limit 1;

  select c.status into v_admin_status
  from public.tenant_feature_controls c
  where c.tenant_id = v_tenant_id
    and c.feature_key = 'payment_documentation'
  limit 1;

  if p_is_enabled and v_admin_status = 'disabled' then
    raise exception 'FEATURE_DISABLED_BY_ADMIN' using errcode = 'P0001';
  end if;

  select * into v_access
  from public.powerhub_payment_documentation_access(v_tenant_id);

  if p_is_enabled and not v_global_enabled then
    raise exception 'FEATURE_GLOBALLY_DISABLED' using errcode = 'P0001';
  end if;

  if p_is_enabled and coalesce(v_access.policy, 'not_included') = 'not_included' then
    raise exception 'FEATURE_NOT_AVAILABLE' using errcode = 'P0001';
  end if;

  -- Only update the owner's preference. Never rewrite tenant_feature_controls here.
  insert into public.tenant_feature_entitlements(
    tenant_id, feature_key, is_enabled, activated_by_user_id,
    activated_at, created_at, updated_at
  )
  values(
    v_tenant_id, 'payment_documentation', p_is_enabled, p_user_id,
    case when p_is_enabled then v_now else null end, v_now, v_now
  )
  on conflict on constraint tenant_feature_entitlements_tenant_id_feature_key_key
  do update set
    is_enabled = excluded.is_enabled,
    activated_by_user_id = excluded.activated_by_user_id,
    activated_at = excluded.activated_at,
    updated_at = excluded.updated_at;

  insert into public.audit_logs(
    tenant_id, site_id, user_id, entity_type, entity_id, action, after_data
  )
  values(
    v_tenant_id, p_site_id, p_user_id, 'tenant_feature_entitlement',
    'payment_documentation',
    case when p_is_enabled then 'enable' else 'disable' end,
    jsonb_build_object(
      'featureKey', 'payment_documentation',
      'policy', v_access.policy,
      'isEnabled', p_is_enabled,
      'adminStatus', coalesce(v_admin_status, 'inherit')
    )
  );

  return query
  select true, v_tenant_id, 'payment_documentation'::text,
         p_is_enabled, coalesce(v_access.policy, 'not_included');
end;
$function$;

revoke all on function public.powerhub_owner_set_payment_documentation(bigint,bigint,boolean) from public, anon, authenticated;
grant execute on function public.powerhub_owner_set_payment_documentation(bigint,bigint,boolean) to service_role;