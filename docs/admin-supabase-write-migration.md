# Admin Supabase Write Migration

## Current stage

This branch adds atomic Supabase RPCs for three legacy admin writes that are currently guarded before MySQL execution:

- `setTenantMembershipStatus`
- `attachOwnerUser`
- `updateSubscription`

The RPCs are service-role-only, use `SECURITY DEFINER` with `search_path = public, pg_temp`, validate the platform actor, perform the related multi-table updates atomically, and write an audit record.

## Intentionally not changed yet

- `server/admin.ts` tRPC callers are still guarded and have **not** been switched to the new RPCs in this stage.
- Production Supabase has **not** received the migration.
- No production data has been changed.
- `NetworkDirectoryPage.tsx`, PR #31, PR #35, and PR #36 are untouched by this branch.

## Next gate

1. Review RPC contracts against production schema.
2. Wire the three tRPC mutations to `supabaseAdmin().rpc(...)`.
3. Add caller-level regression tests proving MySQL/Drizzle is not reached.
4. Run TypeScript/tests/build.
5. Verify Preview.
6. Only then consider a controlled Production migration.
