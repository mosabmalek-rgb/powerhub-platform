-- PowerHub P0: make service-role-only intent explicit for RLS tables that have
-- no end-user policy. The guarded block also tolerates production-only tables
-- introduced by a prior drift migration, so replay from an older schema remains safe.

do $$
declare
  table_name text;
  service_only_tables constant text[] := array[
    'feature_catalog',
    'feature_global_control_audit',
    'generator_owner_provisioning_operations',
    'package_feature_policies',
    'password_reset_intents',
    'payment_documentation_requests',
    'platform_announcement_reads',
    'platform_announcements',
    'powerhub_invoice_sequences',
    'powerhub_user_device_locks',
    'staff_password_reset_intents',
    'tenant_addon_renewal_decisions',
    'tenant_addon_requests',
    'tenant_feature_control_audit',
    'tenant_feature_controls',
    'tenant_feature_entitlements',
    'tenant_owner_alerts'
  ];
begin
  foreach table_name in array service_only_tables loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    end if;
  end loop;
end
$$;

-- This SECURITY DEFINER helper is an internal quota calculation primitive, not
-- a public API. Its callers are privileged RPCs in the same schema.
do $$
begin
  if to_regprocedure('public.powerhub_get_active_addon_delta(bigint,text,timestamptz)') is not null then
    revoke all on function public.powerhub_get_active_addon_delta(bigint,text,timestamptz) from public, anon, authenticated;
    grant execute on function public.powerhub_get_active_addon_delta(bigint,text,timestamptz) to service_role;
  end if;
end
$$;
