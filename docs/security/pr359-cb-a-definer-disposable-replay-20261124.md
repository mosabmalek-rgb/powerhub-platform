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
