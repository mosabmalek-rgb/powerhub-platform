# PowerHub PR #359 — R0 managed service migration provenance gate

**Date:** 2026-11-19. **Scope:** R0 / isolated Docker Shadow only.  
**Status:** `R0_ACCEPTED=false`, `R1_STARTED=false`, `PRODUCTION_SHADOW_UPGRADE_PASS=false`. No hosted DDL, DML, migration history edits, resets, deploy or merge.

## Confirmed source facts

The previous source SHA `625b18bde7a3452064a0c4fd52f076457ea7cc2e` passed PowerHub CI, Security, Admin Guard, PostgreSQL Integration and B5, plus Docker Smoke. The isolated full Docker finance restore **failed** at the protected `verify-managed-catalog-pre-application` gate (workflow `44599860661`, job `135827996685`). It reported 386 managed source columns vs 39 Docker columns, 348 missing, 1 unexpected, 0 mismatched types, 35 missing managed tables. The unexpected local column was `auth.users.email_change_token`. This proves the local image is not source-equivalent; it is not financial restore success.

Read-only service migration history checks established **identical service-ledger record-set hashes** in Production and Staging:
| Service | Rows | SHA-256 of sorted IDs (Storage name+hash) |
|---|---:|---|
| Auth | 84 | `7d1e01029991ce9b74e9c9d06cfccc84d4e7680ecde561f487f416d4996f87b5` |
| Storage | 81 | `be5018da6fa9bc7c7e906420fd91e96b86026d32cf557ee036632074597c61d4` |
| Realtime | 97 | `c446b0b124531009c0d17e544fc3a9acef3a522a70d9a0c6138ace6af47f1633` |

Identical recorded migration IDs do **not** establish identical service binaries, triggers or materialized schemas. Staging's seven extra managed `realtime.messages` partitions dated November 14–20 are attached daily partitions owned by `supabase_realtime_admin`. This partition lifecycle is separately reviewable; never blanket-ignore unexpected tables.

## New implemented fail-closed provenance gate

- `scripts/pr359-shadow/managed-migrations.sql`: read-only metadata-only enumeration of `auth.schema_migrations`, `storage.migrations` (name+hash), and `realtime.schema_migrations`. No user records, secrets or dump contents are requested.
- `scripts/pr359-shadow/check-managed-migrations.mjs`: verifies exact migration IDs and recorded checksums in **both directions**. Rejects missing, extra, changed hashes, empty/malformed service ledgers, duplicate identifiers and unrecognized services; prints aggregated service counts only.
- `scripts/pr359-shadow/check-managed-migrations.test.mjs`: fixture tests for exact equality, missing and extra migrations, divergent Storage checksums, duplicate/invalid records, missing services and read-only query selection.
- `scripts/pr359-shadow/run.sh`: captures source service ledgers via the protected read-only connection, then compares local service histories before importing app schema **and again** after app schema import before data COPY. Source database password is not logged; local database has `docker run --network none`.
- `.github/workflows/pr359-docker-shadow.yml`: includes the new tests in disposable Smoke.
- `scripts/pr359-shadow/readiness.test.mjs`: ensures source ledger export and both comparison checkpoints execute before importing app schema/data.

**Boundary:** Matching service history is necessary but not sufficient: also verify exact managed relation shapes, constraints, indexes, roles, extensions, RLS, trigger definitions, parent/child partitions and service runtime behavior. The existing column comparator still hard-fails on the 348 missing managed columns. No synthetic migration entries or guessed table DDL should be used to satisfy this gate.

## Remaining blocker / next solution

The current `supabase/postgres:17.6.1.155` standalone image has not run the complete compatible hosted Auth/Storage/Realtime service schema migrations; a database engine version is not a complete Supabase service version. Before any real restoration:
1. Identify and pin a **provider-compatible complete local stack and its exact Auth/Storage/Realtime service migration provenance**, including a safe isolated network configuration. `supabase start` is a possible entry point, not proof of parity.
2. Run managed catalog and migration-ledger comparisons as strict prerequisites. Do not mask columns by dropping source tables or modifying auth/storage/realtime on either hosted environment.
3. Rehearse isolated data restore twice with matched snapshots and perform a deliberately failing financial migration rollback only after service parity and Auth semantics are validated.
4. Complete other R0 blockers: 19 Staging-missing RPC contracts, SECURITY DEFINER body-level review, canonical ownership/dependency allowlist, Epoch v2 and full source/historical reconciliation.

**No R1 backup/restore gate is considered accepted or started by this isolated preflight design.** Final-SHA CI evidence must be recorded independently.
