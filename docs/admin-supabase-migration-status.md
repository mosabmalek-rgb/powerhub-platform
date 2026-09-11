# Admin Supabase Migration Status

## Scope
This branch introduces Supabase-native atomic RPC replacements for three legacy admin write paths. The tRPC callers remain guarded and are not yet switched in this phase.

## Implemented RPCs
- `powerhub_admin_set_tenant_membership_status`
- `powerhub_admin_attach_owner_user`
- `powerhub_admin_update_subscription`

## Security
- `SECURITY DEFINER`
- fixed `search_path = public, pg_temp`
- execution revoked from `public`, `anon`, and `authenticated`
- execution granted only to `service_role`
- actor validation requires an active platform admin account
- audit log entries are written inside the database transaction

## Production
No Production Supabase migration has been applied by this branch. No Production deployment is requested.

## Next phase
Wire the corresponding guarded tRPC procedures to these RPCs, add runtime regression tests proving Drizzle is not called, then verify CI and Preview before considering any Production migration.
