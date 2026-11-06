# pg_net Staging controls

**Last read-only audit:** 2026-11-06  
**Project:** `powerhub-staging-dr` (`iyuryuhaylhisjfcrwkz`)

## Verified Staging state

- PostgreSQL 17.6.1; project status `ACTIVE_HEALTHY`.
- `pg_net` version `0.20.4`; extension registration namespace is `public`.
- `pg_extension.extrelocatable = false`; extension owner is Supabase-managed `supabase_admin`.
- The extension-owned request and response objects are in schema `net` (`net.http_request_queue`, `net._http_response`).
- Queue count: **0**.
- Stored response count at audit time: **6** (IDs 4–9; HTTP statuses 401 and 406). No response bodies or headers were copied into this audit.
- `pg_net.ttl = 6 hours`; these response rows are short-lived and may be removed by the extension worker under its normal retention behavior.
- Current `cron.job` contains two active internal jobs (`powerhub_reconcile_expired_field_readers`, `powerhub-subscription-lifecycle`). Neither job calls `net.http_*`.
- A scan of project-owned function bodies found no direct `net.http_*` / `http_post` references. The matching functions found were pg_net internals and Supabase's extension-managed `extensions.grant_pg_net_access` DDL event trigger.
- The application repository contains no pg_net scheduling or request calls. Existing migrations keep HTTP scheduling out of schema migrations.
- The `net` schema is not part of the Staging Data API exposed-schema list recorded in the prior configuration audit.

## Why relocation is not a normal ALTER operation

PostgreSQL reports `pg_net` as non-relocatable. Therefore `ALTER EXTENSION pg_net SET SCHEMA extensions` is not a valid remediation and must not be attempted.

Supabase's hosted remediation should be treated as a managed drop/recreate operation, not an application migration. Dropping the extension removes extension-owned objects, including the request queue and stored-response table. The six Staging response rows would therefore be lost unless archived first.

Reference: [Supabase pg_net documentation](https://supabase.com/docs/guides/database/extensions/pg_net).

## Safe relocation gate

**No relocation was executed during this audit.** The empty queue means there are no pending requests to lose, but the six stored responses remain an explicit preservation decision.

Before any relocation:

1. Re-query the queue and response counts immediately before the operation.
2. Export/archive the complete response history if it must be retained, and verify the archive can be read back.
3. Confirm there are still no project-owned functions, triggers, or Cron commands that depend on `net.http_*`.
4. Obtain explicit approval for the response-history decision, then use Supabase's managed Extensions workflow. Do not use `ALTER EXTENSION SET SCHEMA`, `DROP ... CASCADE`, or application-owned DDL to reassign the extension.
5. Verify the extension namespace is `extensions`, its managed objects remain functional, the queue/response objects exist, the worker is healthy, and Supabase-managed grants/ownership remain intact.

Do not revoke pg_net's Supabase-managed grants, change its worker username, copy Production secrets, add an HTTP Cron job, or alter Production as part of this Staging operation.

## Fresh database behavior

- `20260923130000_powerhub_supabase_cron_invoice_notifications.sql` installs pg_net into `extensions` for fresh environments and does not create HTTP jobs.
- `20260924180000_powerhub_move_pg_net_to_extensions.sql` is intentionally a placement preflight only. It warns when an already-installed extension remains in `public`; it does not try to move or re-own the Supabase-managed extension.
- `server/pg-net-migration-safety.test.ts` protects those non-destructive migration semantics.
