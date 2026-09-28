-- The legacy private RLS helpers are SECURITY DEFINER identity/scope helpers used
-- by authenticated browser RPCs and RLS policies. Keep them unavailable to anon,
-- while restoring the minimum authenticated execute contract required by those paths.
grant usage on schema private to authenticated;

revoke all on function private.powerhub_current_user_id() from anon;
revoke all on function private.powerhub_has_tenant_access(bigint) from anon;
revoke all on function private.powerhub_is_platform_admin() from anon;

grant execute on function private.powerhub_current_user_id() to authenticated, service_role;
grant execute on function private.powerhub_has_tenant_access(bigint) to authenticated, service_role;
grant execute on function private.powerhub_is_platform_admin() to authenticated, service_role;