# PR359 CB-A — networkless privileged trigger behavioral replay

The Docker Shadow smoke workflow includes
`scripts/pr359-canonical/cb-a-definer-disposable.sh`, which launches a
**new disposable PostgreSQL 17.6 instance with `--network none`**.
It generates SQL from the SHA-verified, archived Staging definitions of
`powerhub_ensure_owner_main_site()` and
`powerhub_refresh_fuel_maintenance_delta_after_generator_name_up()`.
The SQL fixture creates *only synthetic* tables, owners and events. It
supplies a small recorder stub in place of the downstream privileged Delta
emitter; the actual producer graph is **not** executed or approved.

The replay checks:
- Serial owner-subscription inserts for two synthetic tenants, a
  repeated subscription insert with `ON CONFLICT DO NOTHING`, staff
  assignment, and cross-tenant isolation in the synthetic schema
- Original captured generator rename logic with 500 unrelated newer
  fuel events and 200 unrelated newer work orders: the older target
  generator rows are omitted from emitted Delta; this is a local
  behavior reproduction, **not evidence of real user data loss**
- An *isolated, not deployable* candidate that adds
  `generator_id=NEW.id` inside each bounded source subquery, preserving
  tenant and site filters; both target rows then produce local events
- No event when the generator name is unchanged

A second isolated test now runs **two independent PostgreSQL sessions**:
session A holds a manually inserted main-site row uncommitted while
session B inserts the same tenant's subscription and triggers the
captured owner-site function. The trigger cannot see session A's
uncommitted site and creates its own; after A commits, the synthetic
schema contains **two main sites for one tenant**. This is a
reproduced cross-path race in the isolated fixture, not proof that
a real deployed customer encountered duplicates. It does not imply
two concurrent `tenant_subscriptions` inserts can bypass that
table's separate unique tenant constraint. A tenant-level advisory
lock and/or an explicitly designed uniqueness/idempotent workflow
needs security and business review before any executable patch. Effective RLS, real emitter
projection/append behavior, full trigger/caller paths, and load testing
remain unverified. The candidate is never written to a migration or
canonical SQL file and is never applied to Staging or Production.

The test requires exact pinned evidence from prior CB-A; a source change
fails before SQL generation. It runs entirely under temporary Docker and
removes the container and test files in a cleanup trap.

```bash
node --test scripts/pr359-canonical/generate-definer-disposable-replay.test.mjs
bash scripts/pr359-canonical/cb-a-definer-disposable.sh
```

```text
CB_A_PINNED_DEFINER_BEHAVIOR_REPLAY=CI_PENDING
CB_A_OWNER_SITE_CROSS_PATH_RACE_REPRODUCTION=CI_PENDING
CB_A_OWNER_SITE_CONCURRENT_SAFETY_APPROVED=FALSE
CB_A_GENERATOR_DELTA_REAL_EMITTER_PROOF=FALSE
CB_A_LOCAL_CANDIDATE_PRODUCTION_APPROVED=FALSE
CB_A_FUNCTION_SECURITY_SIGNOFF=FALSE
CB_B_EXECUTABLE_CANONICAL_BASELINE=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
```

## 2026-11-24: two-session positive-control candidate (Docker-only)

`scripts/pr359-canonical/generate-owner-site-candidate.mjs` derives
one temporary variant from the SHA-pinned live owner-site function.
On the synthetic database only, it creates a partial unique index
`(tenant_id,name) WHERE name='الفرع الرئيسي'` and pairs that constraint
with `INSERT ... ON CONFLICT (...) WHERE ... DO NOTHING RETURNING id`,
followed by a scoped query for the committed site ID. Neither half
may be treated independently as an approved production fix.

The updated networkless test creates tenant 4 and starts an uncommitted
manual site insert in session A. Session B inserts its subscription;
the resulting trigger attempts to insert the same main site. The test
requires PostgreSQL to report a lock wait, commits A, and then checks
that the subscription succeeds and tenant 4 has precisely one main
site plus exactly one owner staff binding.

This demonstrates only the **synthetic cross-path race scenario**
using the captured function body and locally modified candidate.
It does NOT verify existing Staging duplicates, other site creation
paths, traffic-level behavior, effective RLS, the business decision
whether one site per name is universally correct, or safe rollout of
an index on historical rows. A real deployable migration, index
backfill/conflict resolution, controlled advisory locking strategy,
tenant isolation and independent security review remain open.

```text
CB_A_LOCAL_OWNER_SITE_CANDIDATE_TEST=CI_PENDING
CB_A_OWNER_SITE_PRODUCTION_FIX_APPROVED=FALSE
CB_A_GENERATOR_DELTA_PRODUCTION_FIX_APPROVED=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
```

## Historical compatibility and same-generator cap boundary — 24 November 2026

The existing networkless PostgreSQL replay now executes
`fixtures/historical-site-and-generator-boundaries.sql`, guarded by
`historical-site-and-generator-boundaries.test.mjs`.

The **historical duplicate** fixture inserts two synthetic main sites
for tenant 91, plus a separate tenant and an unrelated named site. It
expects PostgreSQL to reject a candidate partial UNIQUE index with
`unique_violation` while retaining all four original rows and leaving
no index behind. A distinct, deliberately pre-reconciled fixture can
create the same index. The test performs **no automatic deduplication**,
does not establish which site should survive, and does not inspect live
Staging or Production data.

The **single-generator cap** fixture adds 500 newer fuel events and
200 newer maintenance orders to the *same* synthetic generator and
fires the candidate rename trigger. It expects exactly 500 and 200
scoped Delta probes, no duplicate events, and excludes the older
target event. This demonstrates that moving the generator filter
inside the limit removes cross-generator starvation but **does not
refresh all historical rows** for high-volume generators. The
application contract (bounded current window versus full historical
backfill), pagination, idempotent replay and downstream producer
behavior must be resolved before a deployment candidate is approved.

These gates remain deliberately non-authorizing:

```text
CB_A_HISTORICAL_DUPLICATE_PRECONDITION=CI_PENDING
CB_A_GENERATOR_FIRST_WINDOW_BOUNDARY=CI_PENDING
HISTORICAL_DATA_RECONCILIATION_APPROVED=FALSE
FULL_GENERATOR_HISTORY_DELTA_PROVEN=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
```

## 2026-11-24: full-history keyset contrast, not a Delta deployment

The new disposable-only test
`fixtures/generator-full-history-keyset-contrast.sql` runs **after** the
500/200 cap-boundary regression. It loops through all 501 synthetic fuel
events and 201 synthetic maintenance work orders of one generator,
using monotonic `id > last_id`, tenant/site/generator predicates and
`ORDER BY id ASC LIMIT 128` in each pass. It verifies 4 fuel pages and
2 maintenance pages, exactly 702 unique synthetic Delta probes,
complete coverage of that generator's seeded records and no cross-tenant
or cross-site probes.

This illustrates the difference between a **bounded recent-change
window** and **explicit full-history backfill**. The demonstration is a
single isolated SQL transaction and uses a recording stub instead of
the real producer; it does **not** prove cursor durability between
transactions, a stable snapshot during writes, crash recovery,
cross-device idempotency, real projected payloads, or runtime security.
No automatic historical refresh should be inferred from a generator
rename until the required backfill contract and operational limits are
designed and accepted.

```text
CB_A_LOCAL_GENERATOR_FULL_HISTORY_KEYSET=CI_PENDING
CB_A_KEYSET_CROSS_TRANSACTION_RECOVERY=FALSE
CB_A_REAL_EMITTER_REPLAY_AND_RLS_PROOF=FALSE
GENERATOR_FULL_HISTORY_DEPLOYMENT_APPROVED=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
```

## 24 November 2026 — atomic checkpoint recovery in isolated PostgreSQL

The disposable replay now runs four **independent psql connections** against
one fresh `--network none` PostgreSQL instance, using the files
`fixtures/keyset-restart-{setup,failure,first-page,after-crash}.sql`
and the source guards in `keyset-restart.test.mjs`.

The synthetic `SECURITY INVOKER` function locks a checkpoint per
`(tenant_id,site_id,generator_id,kind)`, reads a bounded page of up to
128 event IDs, writes to a sink protected by a composite unique key,
and advances the cursor within that same PostgreSQL transaction.

The test deliberately raises SQLSTATE `P3591` after writing the first
64 rows but before checkpoint update. The test checks that **both**
sink inserts and cursor update roll back. A new connection commits
the first 64 events; a further new connection resumes with 64+2 fuel
events and 64+6 maintenance work orders. The resulting 200 events
must be unique and scoped to the one synthetic tenant/site/generator.

The high-water mark test adds a new event after initial snapshot
capture and confirms that the earlier run does not silently consume
that event. It must be considered by a **new** snapshot/run.

The test is not a production backfill implementation. It does not
verify the actual Delta producer, multi-device idempotency, RLS,
logical snapshot consistency across concurrent writes, deletion
tombstones, authenticated RPC callers, or guarantees across
non-transactional external delivery. The synthetic checkpoint/sink
tables are created only in the temporary Docker instance and are not
added to migrations or Canonical Baseline DDL.

```text
CB_A_KEYSET_CROSS_CONNECTION_RECOVERY=CI_PENDING
CB_A_REAL_DELTA_OUTBOX_ATOMICITY=FALSE
CB_A_CROSS_DEVICE_IDEMPOTENCY=FALSE
CB_B_CANONICAL_SQL_AUTHORED=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
```

## 24 November 2026 — synthetic change journal and tombstone replay

The disposable PostgreSQL gate now also tests a sequence-based mutation
journal, independently of the record-ID keyset history experiment. It uses
`fixtures/journal-restart-{setup,failure,first-page,resume}.sql` with
`journal-restart.test.mjs` and **four distinct database connections**.

A scoped journal `change_seq` records `upsert` and `delete` changes.
Its synthetic consumer locks the scope checkpoint, applies a bounded
sequence page to an idempotent materialized sink, and advances the checkpoint
**in one local PostgreSQL transaction**. The injected `P3592` failure
after writes but before cursor update must roll back both. The first page
commits a deletion tombstone for event 201; after restarting, event 202
has the latest revision 2 `upsert`. A later `delete` for event 202,
inserted after the original high-water mark, must be excluded until a
fresh snapshot is explicitly opened, then applied without resurrecting
event 201. Unrelated tenants/sites/generators are excluded.

This test shows why record-ID history alone cannot handle changes to
older records or deletion tombstones. It is **not** a full production
change-data-capture system: transaction commit ordering of sequence
allocation, concurrent journal writes, real producer execution,
tombstone retention/garbage collection, missing sequence handling, RLS,
consumer authentication and Android integration remain unverified.
The synthetic SQL uses `SECURITY INVOKER`, does not create any actual
application migration, and is never connected to a hosted database.

```text
CB_A_SYNTHETIC_CHANGE_JOURNAL_REPLAY=CI_PENDING
CB_A_REAL_DELTA_PRODUCER_ATOMICITY=FALSE
CB_A_REAL_CHANGE_JOURNAL_CAPTURE=FALSE
CB_A_TOMBSTONE_RETENTION_POLICY_APPROVED=FALSE
CB_B_CANONICAL_SQL_AUTHORED=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
```
