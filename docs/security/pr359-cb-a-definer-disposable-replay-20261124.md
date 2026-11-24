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

No concurrent owner-site transactions are executed in this first
behavioral replay. The absence of a tenant/name unique index is a risk
candidate; it is not a proven race. Effective RLS, real emitter
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
CB_A_OWNER_SITE_CONCURRENT_TRANSACTION_PROOF=FALSE
CB_A_GENERATOR_DELTA_REAL_EMITTER_PROOF=FALSE
CB_A_LOCAL_CANDIDATE_PRODUCTION_APPROVED=FALSE
CB_A_FUNCTION_SECURITY_SIGNOFF=FALSE
CB_B_EXECUTABLE_CANONICAL_BASELINE=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
```
