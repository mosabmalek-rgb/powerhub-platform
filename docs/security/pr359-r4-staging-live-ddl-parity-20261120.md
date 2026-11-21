# PowerHub PR359 — Staging live function/index/constraint definition SHA-256 parity

**Date:** 2026-11-20. Source Git head reviewed: `30d3796723a4d40491b3db6c2d1c846eaf0b0969`.
**Method:** Supabase `execute_sql` SELECT-only requests to Staging `iyuryuhaylhisjfcrwkz`; R0 snapshots from GitHub.

## Read-only observations

- Exactly 641/641 function signatures matched source R0 SHA-256 from `pg_get_functiondef` (7 pages of up to 100). No missing or changed definitions.
- Exactly 688/688 index identities and 1,437/1,437 constraint identities matched source R0 SHA-256 (15 pages of up to 150). No missing or changed definitions.
- The Staging catalog counts were independently checked: 688 indexes, 1,437 constraints, 561 foreign keys, 0 invalid indexes, 0 unvalidated constraints; 3 app-to-Auth foreign keys.
- An initial 531 apparent constraint differences were due to comparing `pg_get_constraintdef(oid)` with historical hashes computed from the pretty-printed overload. Using the correct historical representation `pg_get_constraintdef(oid,true)` yielded **zero** differences. Neither representation was modified in the database.
- All the comparisons used only object identity, hashing, and catalog metadata; no user data, SQL function source bodies, or secrets were returned.

## Reproducibility

`scripts/pr359-r4/live-ddl-parity.mjs` emits 22 read-only SQL files using SHA-256 reference values from the repository's R0 snapshots, and can strictly inspect 22 matching JSON result files.

Example **local preparation only**:

```sh
node scripts/pr359-r4/live-ddl-parity.mjs --emit-sql /tmp/pr359-r4-parity
```

Execute each generated query only via a verified **Staging read-only connection**, using `psql -X -qAt -v ON_ERROR_STOP=1`, and save its one JSON result line under the corresponding `.result.json` filename; then run:

```sh
node scripts/pr359-r4/live-ddl-parity.mjs --check-results /tmp/pr359-r4-parity
```

The emitted SQL contains no mutation, does not know the database URI, and never accepts one. Any missing/changed object, extra object, wrong result count, incomplete report, or SQL hash mismatch causes fail-closed rejection. The test fixture checks source coverage and the `pretty=true` constraint representation.

## Scope limits and next gate

Observations came from several independent read-only SQL statements, **not one transactionally consistent Staging snapshot**. The SHA parity covers function definitions and index/constraint definitions, not the complete table columns/defaults, RLS/policy/grant fingerprints, triggers, cron, owner dependency decisions, or an empty-stack canonical application build. Provider-managed schemas and live Auth/Storage remain outside any cleanup authorization.

R4_STAGING_FUNCTION_SHA_PARITY=OBSERVED_641_OF_641
R4_STAGING_INDEX_SHA_PARITY=OBSERVED_688_OF_688
R4_STAGING_CONSTRAINT_SHA_PARITY=OBSERVED_1437_OF_1437
R4_ATOMIC_CATALOG_ATTESTATION=false
R4_APP_OWNED_SIGNED=false
R4_STAGING_INPLACE_GO=false
R6_PRODUCTION_INPLACE_GO=false
PR359_MERGE_GO=false
