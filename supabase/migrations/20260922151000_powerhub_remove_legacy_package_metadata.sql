-- Final cleanup: five commercial package codes are the only supported package identity.
-- No tenant data is deleted. Legacy compatibility columns are removed only if they still exist.

alter table public.tenant_subscriptions
  drop column if exists plan;

alter table public.tenants
  drop column if exists plan;

update public.platform_settings
set value = jsonb_set(
  value,
  '{packages}',
  coalesce(
    (
      select jsonb_agg(package_row - 'legacyPlan' order by ord)
      from jsonb_array_elements(coalesce(value->'packages','[]'::jsonb)) with ordinality as p(package_row, ord)
    ),
    '[]'::jsonb
  )
),
updated_at = now()
where setting_key = 'subscription_package_catalog'
  and jsonb_typeof(value->'packages') = 'array';

update public.platform_settings
set value = value - 'legacyFallback',
    updated_at = now()
where setting_key = 'branch_feature'
  and jsonb_typeof(value) = 'object';

do $$
begin
  if exists (
    select 1
    from public.tenant_subscriptions
    where package_code not in ('basic','advanced','professional','business','vip')
  ) then
    raise exception 'UNSUPPORTED_PACKAGE_CODE_REMAINS' using errcode='23514';
  end if;

  if exists (
    select 1
    from public.tenants
    where package_code not in ('basic','advanced','professional','business','vip')
  ) then
    raise exception 'UNSUPPORTED_TENANT_PACKAGE_CODE_REMAINS' using errcode='23514';
  end if;
end
$$;
