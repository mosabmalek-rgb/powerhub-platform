-- Defense-in-depth: keep internal authorization helpers unreachable from the anonymous role.
-- Authenticated and service-role callers retain the privileges used by RLS and server-side flows.
revoke all on schema powerhub_private from public, anon;
grant usage on schema powerhub_private to authenticated, service_role;

revoke all on function powerhub_private.current_user_id() from public, anon;
revoke all on function powerhub_private.current_tenant_ids() from public, anon;
revoke all on function powerhub_private.is_platform_user() from public, anon;

grant execute on function powerhub_private.current_user_id() to authenticated, service_role;
grant execute on function powerhub_private.current_tenant_ids() to authenticated, service_role;
grant execute on function powerhub_private.is_platform_user() to authenticated, service_role;
