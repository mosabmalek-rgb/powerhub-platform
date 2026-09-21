-- Reconcile the Production feature-entitlement constraint with the current runtime contract.
-- Intentionally narrow: no data backfill and no RPC recreation.

do $$
declare
  v_constraint_name text;
begin
  select c.conname
    into v_constraint_name
  from pg_constraint c
  where c.conrelid = 'public.tenant_feature_entitlements'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%feature_key%'
    and pg_get_constraintdef(c.oid) ilike '%subscriber_portal_logo%'
  order by c.oid
  limit 1;

  if v_constraint_name is not null then
    execute format(
      'alter table public.tenant_feature_entitlements drop constraint %I',
      v_constraint_name
    );
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from public.tenant_feature_entitlements
    where feature_key not in ('subscriber_portal_logo', 'payment_documentation')
  ) then
    raise exception 'UNSUPPORTED_TENANT_FEATURE_KEY'
      using errcode = 'P0001',
            detail = 'Unexpected feature_key exists in tenant_feature_entitlements';
  end if;
end
$$;

alter table public.tenant_feature_entitlements
  add constraint tenant_feature_entitlements_feature_key_check
  check (feature_key in ('subscriber_portal_logo', 'payment_documentation'));

alter table public.tenant_feature_entitlements enable row level security;

revoke all on table public.tenant_feature_entitlements
  from public, anon, authenticated;

grant all on table public.tenant_feature_entitlements to service_role;
