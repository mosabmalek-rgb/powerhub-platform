-- Lock the new admin RPC surface to trusted server-side callers only.
-- Runtime tRPC wiring remains intentionally separate until verified.

revoke all on function public.powerhub_admin_set_tenant_membership_status(bigint, bigint, bigint, text) from public, anon, authenticated;
revoke all on function public.powerhub_admin_attach_owner_user(bigint, bigint, bigint, bigint) from public, anon, authenticated;
revoke all on function public.powerhub_admin_update_subscription(bigint, bigint, text, text, text, timestamptz, boolean, text, bigint) from public, anon, authenticated;

grant execute on function public.powerhub_admin_set_tenant_membership_status(bigint, bigint, bigint, text) to service_role;
grant execute on function public.powerhub_admin_attach_owner_user(bigint, bigint, bigint, bigint) to service_role;
grant execute on function public.powerhub_admin_update_subscription(bigint, bigint, text, text, text, timestamptz, boolean, text, bigint) to service_role;
