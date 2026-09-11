# Admin Supabase Write Migration — Stage 1

This branch adds atomic, service-role-only Supabase RPC contracts for three legacy admin writes:

- `setTenantMembershipStatus`
- `attachOwnerUser`
- `updateSubscription`

The existing tRPC callers remain guarded in this stage. This deliberately separates database contract creation from application wiring so the migration can be reviewed and tested without enabling legacy MySQL writes or changing Production.

## Safety gate

- No Production Supabase migration applied.
- No Production data changed.
- No PR #31 / P7.4 changes.
- No PR #35 invoice changes.
- No PR #36 WhatsApp changes.

## Next

Wire the tRPC callers to these RPCs, add runtime tests proving Drizzle is not called, run CI and Preview, then consider controlled Production migration.