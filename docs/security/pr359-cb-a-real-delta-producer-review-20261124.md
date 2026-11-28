# PR359 CB-A — real fuel/maintenance Delta producer attestation

Captured on 24 November 2026 with read-only `pg_catalog` queries
against Staging project `iyuryuhaylhisjfcrwkz`.

## Source evidence

`docs/security/pr359-cb-a-live-delta-producer-evidence-20261124.json`
pins four full catalog function bodies, their direct trigger definitions and
effective EXECUTE privilege flags. The Git blob SHA is
`f851a32e73ce652729e418d570973d1967e8934e`.
The fail-closed, source-only code gate is
`scripts/pr359-canonical/cb-a-real-delta-producer-audit.mjs`.

The captured `powerhub_append_fuel_maintenance_delta_sync_change`
function increments `powerhub_sync_scope_state.last_cursor` through
`INSERT ... ON CONFLICT(tenant_id,site_id,entity_type) DO UPDATE
SET last_cursor=last_cursor+1 RETURNING last_cursor`, then inserts a
change into `powerhub_sync_changes` using the returned cursor. Both
writes are in the same PostgreSQL function invocation; an ordinary
unhandled error would abort the enclosing SQL statement/transaction.
The source register confirms that these two tables have primary keys
on `(tenant_id,site_id,entity_type)` and
`(tenant_id,site_id,entity_type,cursor)`, respectively. PostgreSQL's
row-conflict locking is materially different from the unsafe synthetic
IDENTITY allocation demonstrated previously; the negative
IDENTITY demonstration **must not be reported as a discovered defect
in the actual append function**.

The capture trigger runs AFTER INSERT/UPDATE/DELETE on:
- `generator_fuel_events`
- `generator_maintenance_work_orders`
- `generator_maintenance_work_order_parts`

The downstream emit function uses a scoped projector and calls append
for a projected `upsert`, or a `delete` tombstone when the projected
row is missing. Scope-changing operations append a tombstone for the
old scope. The pull function restricts reads to the requested
tenant/site/entity type and cursor range and returns
`reset_required` when `after_cursor` precedes the retained floor.
The captured append function retains a bounded window, advancing
`retained_from_cursor` during pruning.

All four functions are `SECURITY DEFINER`, with
`anon`/`authenticated` EXECUTE denied and `service_role`
EXECUTE allowed in the captured Staging role state.
These observations do not replace an exhaustive direct/indirect
caller, RLS or grant analysis.

## What still needs proof

- Concurrent source writes with the **actual** append function and schema,
  including rollback, trigger failure, deletes, scope moves and replay
- Every app/SQL write path uses the same trusted producer chain; no direct
  writes or noncompliant administrative bypasses
- Correct retained-floor behavior, stale Android client reset and
  full-history rebootstrap without resurrecting deleted data
- Isolation under effective service-role entry points and tenant/site
  authorization, including parts projections
- Migration source provenance, dependency closure and independent review

The synthetic negative test for a writer that bypasses an advisory
lock remains useful for reasoning about incomplete protocols, but
**does not establish that the real, row-serialized producer has that
vulnerability**.

```bash
node --test scripts/pr359-canonical/cb-a-real-delta-producer-audit.test.mjs
node scripts/pr359-canonical/cb-a-real-delta-producer-audit.mjs --out /tmp/pr359-real-delta-audit.json
```

```text
CB_A_REAL_DELTA_PRODUCER_STATIC_ATTESTATION=CI_PENDING
CB_A_ACTUAL_DELTA_CONCURRENT_REPLAY=FALSE
CB_A_ALL_PRODUCER_PATHS_APPROVED=FALSE
CB_A_REAL_RUNTIME_ISOLATION_APPROVED=FALSE
CB_B_CANONICAL_SQL_APPROVED=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
```

## 24 November 2026 — archived operational trigger behavior in networkless PostgreSQL

Added `fixtures/real-capture-disposable.sql.in`,
`generate-real-capture-disposable.mjs`, and its static regression tests.
The Docker Shadow `cb-a-real-append-disposable.sh` now creates
`pr359_real_capture` as a **second, disposable database** within the
existing `--network none` container. It loads the exact archived
`capture`, `emit`, and `append` SECURITY DEFINER definitions and all
three archived AFTER INSERT/UPDATE/DELETE triggers.

Only the source tables, record projector functions and bounded
refresh functions are synthetic. The projector and refresh stubs do
**not** prove production field projection, data integrity, RLS,
authorization, retention, or performance.

The database checks:
- fuel insert, changed-row update, and delete, with three ordered cursors
- maintenance work-order site move: old-scope tombstone and new-scope
  upsert, followed by a deletion tombstone
- maintenance part work-order move: old entity-type tombstone and
  new entity-type upsert/delete
- a deliberately raised exception *after* a valid source INSERT and
  AFTER trigger: the source row, log row, and cursor all roll back
- invalid site scope: the real append function raises and the whole
  source INSERT rolls back

The test executes no SQL on hosted projects and creates no migration.
The dedicated test uses an unmodified source function body and the
pinned trigger definitions, but is **not** a complete actual-schema
or end-to-end authorization test.

```text
CB_A_REAL_CAPTURE_ISOLATED_THREE_TRIGGERS=CI_PENDING
CB_A_ACTUAL_DB_SCHEMA_AND_PROJECTION=FALSE
CB_A_ALL_REAL_TRIGGER_CALLERS_APPROVED=FALSE
CB_A_RLS_AND_SERVICE_ROLE_AUTHORIZATION=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
```
