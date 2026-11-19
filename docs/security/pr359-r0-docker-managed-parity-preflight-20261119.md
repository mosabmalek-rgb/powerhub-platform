# PowerHub PR359 — R0 fail-closed provider-managed schema preflight

**Date:** 2026-11-19  
**Scope:** `PR359 Docker Shadow (disposable)` only. The linked Production and Staging databases remain read-only and unchanged.  
**Decision:** R0 still IN PROGRESS / NOT ACCEPTED; R1 NOT STARTED; Production and Staging rebaseline NO-GO.

## Evidence from the completed prior CI run

At source SHA `41bf5085d5369e4e951b7018a78acca994a1be50`, PowerHub CI, Security, PostgreSQL Integration, Supabase Admin Guard, and B5 all passed. Docker Shadow's `smoke` job also passed, but the `real-restored-finance` job failed.

- Workflow run `44595656766`; job `135813247827`.
- Failure checkpoint: `verify-managed-catalog` after application schema import, before application data COPY.
- Source provider-managed catalog had **386 columns**, Docker catalog had **39**; **348 source columns were missing** and **0 types mismatched**.
- This proves the previous `auth.audit_log_entries.ip_address varchar(64)` correction removed the single column-type mismatch. It does **not** prove Auth, Storage or Realtime managed-schema compatibility.
- `smoke` passing is not a restored-Production acceptance result.

## Changes implemented this round

1. `scripts/pr359-shadow/run.sh`: after local-only role/Vault/GraphQL setup and source-attested Auth audit metadata compatibility bootstrap, the full workflow now checks the complete provider-managed schema catalog **before** importing app schema. It fails closed at `verify-managed-catalog-pre-application` if incompatible. After app schema import it performs a **second** full check at `verify-managed-catalog-post-application` before data COPY, protecting against managed-schema changes introduced by the app dump.
2. `scripts/pr359-shadow/readiness.test.mjs`: static regression test asserts both managed checks exist, that the precheck precedes application schema restore, and that the postcheck precedes data restoration.
3. `scripts/pr359-shadow/check-managed-catalog.mjs`: emits only **per-managed-schema missing-column counts**, without exposing values, credentials or raw SQL. The full comparison and fail-closed behavior remain intact.

**Scope distinction:** The local-only one-column Auth compatibility patch already existed and is not a replacement for managed service migrations. No schema is fabricated to make the comparator green. Both checked environments remain under their existing Project Refs.

## Provenance and recommended route to true restored database tests

The test currently launches networkless `supabase/postgres:17.6.1.155` directly. This image is not proof that full, matching hosted Supabase Auth/Storage/Realtime service migrations are installed. The proper remedy is a **version-attested, isolated Supabase service migration baseline** consistent with the hosted catalog and source data, or another fully justified compatible environment. Prefer provider-supported complete local Supabase-stack initialization as a starting point, but verify exact version/catalog equivalence rather than assuming a CLI version guarantees parity.

Do **not** use source column dumps to generate guessed `CREATE TABLE` statements or disable verification. Supabase-managed schema may require indexes, checks, triggers, foreign keys, roles, API service assumptions and migration-ledger provenance, not merely column names.

1. Capture source metadata-only Auth/Storage/Realtime catalog fingerprint, ownership, column types/defaults, constraints, indexes, and extension versions. No credentials or user data in Git.
2. Pin local Supabase image and service-migration provenance; initialize a **disposable** compatible Supabase stack with no externally published ports or remote credentials.
3. Run precheck; classify any version drift. Only after managed compatibility PASS, restore application schema and verify again before any data COPY.
4. Prove managed data and Auth account/session behavior using isolated test identities, followed by restore replay twice and a controlled failure/recovery run. Do not send external SMS or touch shared remote projects.

The current Docker workflow is intentionally expected to remain **FAIL** until the managed compatibility requirement is met. CI workflow conclusions must be checked on the exact final SHA.

**Blocked gates:** `R0_ACCEPTED=false`, `BACKUP_RESTORE_PASS=false`, `PRODUCTION_SHADOW_UPGRADE_PASS=false`, `PR359_MERGE_GO=false`. No staging or production app reset authorized.
