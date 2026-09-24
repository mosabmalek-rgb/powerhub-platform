# Client write-boundary source reconciliation

## Finding

The live Production database already enforces the intended client write boundary.
The Supabase migration history contains the equivalent hardening as:

- `20260917205611 / harden_client_write_boundary`
- `20260917205630 / close_remaining_client_table_writes`

A read-only privilege audit on 2026-09-24 confirmed that the reviewed tables have
no direct INSERT/UPDATE/DELETE/TRUNCATE privilege for `anon` or `authenticated`,
and RLS is enabled on the reviewed tables. `service_role` retains the expected
server-side DML privileges on representative business tables.

The Production `users` table also has no `users_self_update` policy.

## Why this PR exists

PR #57 was based on an older branch whose migration filenames no longer matched
the migration history already present in Production. This reconciliation keeps the
security contract represented in Git without applying a destructive or duplicate
schema change.

The SQL is idempotent: reapplying the revokes and dropping a non-existent policy
does not change the intended final privilege state.

## Merge gate

Do not apply this migration to Production as a corrective action for an already
secured database. Merge only after CI, Security, and Supabase Admin Guard pass on
the current `main` line and the migration remains source-control compatible.

After merge, future staging environments can replay the repository migration chain
and converge to the same client write boundary.
