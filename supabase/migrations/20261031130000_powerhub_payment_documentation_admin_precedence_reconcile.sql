-- Reconcile the Production payment-documentation owner/admin precedence drift.
-- This is safe to apply in both environments: the data repair only touches
-- controls last written by an owner toggle and is idempotent; function bodies
-- and server-only ACLs converge to the tested admin-authoritative contract.

-- Keep platform-admin feature availability separate from the generator owner's preference.
-- Historically the owner toggle also rewrote tenant_feature_controls.status, which could
-- erase an explicit admin disable. Restore admin state from its audit snapshot where the
-- previous owner RPC was the last writer, and reset owner-only legacy control rows without deleting them.

-- Restore the latest recorded platform-admin state where an owner toggle overwrote it.
-- For rows with no prior audit snapshot, reset only the duplicate control state to "inherit";
-- preserve the independent owner preference in tenant_feature_entitlements.
with owner_written_controls as (
  select
    c.id,
    c.tenant_id,
    c.feature_key,
    c.updated_at as previous_updated_at,
    a.actor_user_id,
    a.created_at as audit_created_at,
    a.after_data,
    a.reason as audit_reason
  from public.tenant_feature_controls c
  join public.tenant_members tm
    on tm.tenant_id = c.tenant_id
   and tm.user_id = c.updated_by_user_id
   and tm.role = 'owner'
  left join lateral (
    select a.actor_user_id, a.created_at, a.after_data, a.reason
    from public.tenant_feature_control_audit a
    where a.tenant_id = c.tenant_id
      and a.feature_key = c.feature_key
      and a.created_at < c.updated_at
    order by a.created_at desc, a.id desc
    limit 1
  ) a on true
  where c.feature_key = 'payment_documentation'
)
update public.tenant_feature_controls c
set status = coalesce(o.after_data->>'status', 'inherit'),
    limit_mode = coalesce(o.after_data->>'limit_mode', o.after_data->>'limitMode', 'inherit'),
    manual_limit = case
      when coalesce(o.after_data->>'manual_limit', '') ~ '^\d+$'
        then (o.after_data->>'manual_limit')::integer
      else null
    end,
    override_reason = coalesce(o.after_data->>'override_reason', o.audit_reason),
    updated_by_user_id = o.actor_user_id,
    updated_at = coalesce(
      (o.after_data->>'updated_at')::timestamptz,
      o.audit_created_at,
      o.previous_updated_at
    )
from owner_written_controls o
where c.id = o.id;

create or replace function public.powerhub_payment_documentation_access(p_tenant_id bigint)
returns table(allowed boolean, policy text, package_code text, entitlement_enabled boolean)
language plpgsql
stable
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_global_enabled boolean := false;
  v_package_code text;
  v_package jsonb;
  v_policy text := 'not_included';
  v_entitlement boolean;
  v_entitlement_found boolean := false;
  v_control_status text := 'inherit';
  v_control_found boolean := false;
  v_allowed boolean := false;
begin
  select coalesce(fc.is_active, false) into v_global_enabled
  from public.feature_catalog fc
  where fc.feature_key = 'payment_documentation'
  limit 1;

  select ts.package_code into v_package_code
  from public.tenant_subscriptions ts
  where ts.tenant_id = p_tenant_id
    and ts.status in ('trial','active')
    and (ts.ends_at is null or ts.ends_at > now())
  order by ts.created_at desc, ts.id desc
  limit 1;

  if v_package_code is not null then
    select package_row into v_package
    from jsonb_array_elements(coalesce(
      (select ps.value->'packages'
       from public.platform_settings ps
       where ps.setting_key = 'subscription_package_catalog'
         and ps.is_enabled = true
       limit 1),
      '[]'::jsonb
    )) as package_row
    where package_row->>'code' = v_package_code
      and coalesce((package_row->>'active')::boolean, true) = true
    limit 1;

    if v_package is not null then
      v_policy := case
        when v_package ? 'paymentDocumentationPolicy'
          then coalesce(v_package->>'paymentDocumentationPolicy', 'not_included')
        when coalesce((v_package->'features'->'paymentDocumentation'->>'included')::boolean, false)
          then 'included'
        when coalesce((v_package->'features'->'paymentDocumentation'->>'enabled')::boolean, false)
          then 'addon'
        else 'not_included'
      end;
    end if;
  end if;

  select c.status into v_control_status
  from public.tenant_feature_controls c
  where c.tenant_id = p_tenant_id
    and c.feature_key = 'payment_documentation'
  limit 1;
  v_control_found := found;

  select e.is_enabled into v_entitlement
  from public.tenant_feature_entitlements e
  where e.tenant_id = p_tenant_id
    and e.feature_key = 'payment_documentation'
  limit 1;
  v_entitlement_found := found;

  v_allowed := v_global_enabled
    and v_policy in ('included','addon')
    and case
      -- An explicit platform-admin disable is authoritative. An owner cannot opt back in.
      when v_control_found and v_control_status = 'disabled' then false
      -- The owner preference is stored independently from the admin's availability decision.
      when v_entitlement_found then coalesce(v_entitlement, false)
      -- An explicit admin enable defaults to enabled if there is no separate owner choice yet.
      when v_control_found and v_control_status = 'enabled' then true
      -- Preserve the package default for included plans; add-ons require explicit enablement.
      when v_policy = 'included' then true
      else false
    end;

  return query
  select v_allowed, v_policy, v_package_code, coalesce(v_entitlement, false);
end;
$function$;

revoke all on function public.powerhub_payment_documentation_access(bigint) from public, anon, authenticated;
grant execute on function public.powerhub_payment_documentation_access(bigint) to service_role;

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
