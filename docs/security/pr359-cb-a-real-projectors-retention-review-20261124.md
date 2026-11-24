# PR359 CB-A — Delta projection and retention boundary (read-only plus disposable tests)

24 November 2026. The authoritative Staging inspection was **read-only**.

## Projectors captured

`docs/security/pr359-cb-a-real-delta-projectors-20261124.json` pins
three SQL SECURITY DEFINER functions for fuel events, maintenance work
orders, and maintenance work-order parts, and their current direct
EXECUTE permissions. Git blob SHA:
`3102f6b3c59af9054c4d53643ac2a9988058cab7`.
The static guard `cb-a-real-projectors-audit.mjs` requires each
projector to filter by tenant/site and validates the scoped joins for
related generators, inventory items, warehouses, suppliers and work
orders. Both `anon` and `authenticated` lack direct EXECUTE; the
captured `service_role` has it. These checks do not prove full caller
closure, operational RLS isolation, complete source rows or accepted
Android payloads. No SQL was executed against hosted data.

## Real Append + Pull retention experiment

`fixtures/real-delta-retention-disposable.sql` uses exactly the
pinned `powerhub_append_fuel_maintenance_delta_sync_change` and
`powerhub_pull_fuel_maintenance_sync_delta` function definitions
already loaded into `pr359_real_append`, a PostgreSQL database
created in a Docker container with `--network none`. The test
pre-populates an isolated scope with 10,499 *synthetic* changes,
then appends the 10,500th event using the real function. At this
boundary the function must prune the earliest 500 events, retain
10,000 rows and raise `retained_from_cursor` to 500.

It requests Delta with `after_cursor=499` and `after_cursor=NULL`
and expects `reset_required`. At `after_cursor=500` it expects
a bounded 200-event page, `has_more=true`, the correct
`through_cursor` and a `next_cursor` of 700. The final page
must return cursor 10,500 with `has_more=false`; unrelated
tenant and site cursors must be unaffected.

### Important constraints

A `reset_required` response means the server cannot safely bridge
the missing events. **Android must not simply advance its stored cursor
or delete a local Outbox.** The correct recovery mechanism requires
the client to obtain a new authorized snapshot, reconcile/de-duplicate
all relevant local records, preserve pending local writes, then commit
the snapshot and its cursor atomically. This repository's static Retrofit
route audit is not proof of this runtime behavior.

The test proves only database behavior under a disposable fixture;
it does NOT verify Android snapshot/bootstrap recovery, producer
performance on a hosted database, true privilege delegation, the
real projection joins at runtime, or migration readiness.

```text
CB_A_PROJECTORS_STATIC_REVIEW=CI_PENDING
CB_A_REAL_RETENTION_DISPOSABLE=CI_PENDING
CB_A_ANDROID_RESET_RUNTIME=FALSE
CB_A_OUTBOX_PRESERVATION_RUNTIME=FALSE
CB_A_PROJECTOR_END_TO_END_ACCEPTANCE=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
```
