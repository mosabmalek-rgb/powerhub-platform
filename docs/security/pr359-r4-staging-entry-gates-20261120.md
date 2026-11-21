# PR #359 — R4 Staging in-place readiness, non-destructive entry

**Date:** 2026-11-20. **Starting SHA:** `b522ff6e1068786b7d3c50ea614cf8b348710ea7`.
**Run:** [Docker Shadow #44617925351](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/44617925351).
R0–R3 acceptance is reported and the above full-restore run and all six PR workflows were independently observed **SUCCESS** on the starting SHA. R4 preparation does not reverse these results, but does NOT authorize writes.

## Staging-only live observation (one read-only PostgreSQL statement)

Project `iyuryuhaylhisjfcrwkz` returned 325 public and 12 private relations/views/sequences in the specified relkind inventory; seven Auth users; zero Storage object metadata rows and one bucket; 553 application migration rows, max version `20261116231000`; two cron jobs; 52 authenticated-reachable SECURITY DEFINER functions; no custom `auth.users` triggers; exactly three application foreign keys to `auth.users`. The SQL and metadata-only JSON are versioned in this change.

Production `vvcdiqcyhaloxesvpppc` was inspected with the same read-only SQL: four Auth users, five Storage objects, two buckets, 486 migration rows and seven Cron jobs; its `auth.users` application trigger still exists. **No hosted schema/data/session was changed.**

**Notable scope:** Counts do not prove row-level semantics, RPC correctness, point-in-time backup durability, or ownership classification. No authenticated user identities, SMS credentials, raw cron commands, or data rows were captured.

## What is complete

- Baseline R0–R3 CI/isolated restore passes on previous pinned SHA; full runner uses ephemeral Supabase Local Stack, not a persistent Staging snapshot.
- Staging metadata inventory re-read with SELECT only, recorded in `pr359-r4-staging-preflight-20261120.json`.
- Added `scripts/pr359-r4/staging-preflight.sql`, metadata-only `staging-preflight.mjs` and negative/positive tests to Docker Shadow smoke CI.
- The checker fails on snapshot drift, unknown app schema, Auth trigger or FK changes; passing NEVER sets `STAGING_INPLACE_GO`.

## Blocking R4 execution gates (no inference from restore success)

1. **Ownership and dependency manifest:** signed APP_OWNED object allowlist with exact DDL and explicit cross-schema inbound/outbound dependency review; no UNKNOWN or provider-managed object may enter a removal plan. Reconcile 19 Staging-missing RPCs and SECURITY DEFINER behavior against actual current code where still applicable.
2. **Canonical target vs source restore:** verify R2's target really builds the **current web/server + Android contract** from reviewed Git SQL and privileges, not just successful replay of Finance migrations on a cloned older Production dump. Compare staged final target signatures, RLS, grants, event triggers, extensions and financial objects; independently demonstrate this from an empty compatible local stack.
3. **Migration Epoch v2:** an independently rehearsed switch/ledger strategy preserving historical evidence; do not delete, rewrite, or fake `supabase_migrations.schema_migrations`.
4. **Fresh recoverable backup:** a persistent off-runner encrypted SQL/roles/ACL/history backup with checksums and verified restore; Auth identities/config and Storage object bytes/backups, plus Cron, Realtime and environment configuration. The CI run's temporary `$work/dump` is cleaned at exit and is **not** a retained pre-R4 rollback artifact.
5. **Boundary contract:** decide disposition of seven Staging test Auth identities and one Storage bucket; device locks, offline Outbox, Delta/tombstones/cursor epoch, service-role Preview binding, Android versions and external dependencies. No stale cache or lost unsent outbox after rebaseline.
6. **Stop/recovery & approval:** freeze writes and Cron/automation/edge/SMS, verify snapshot immediately preflight, have tested rollback including partial failure, and obtain explicit fresh sign-off for exact Staging commands/SQL SHA. No `DROP SCHEMA public CASCADE` or `supabase db reset --linked`.

## Current decision

`R0_R3_RESTORATION_EVIDENCE=VERIFIED_ON_B522FF6E`

`R4_STAGING_READ_ONLY_INVENTORY_CAPTURED=true`

`R4_APP_OBJECT_ALLOWLIST_SIGNED=false`

`R4_MIGRATION_EPOCH_V2_RELEASE_PROOF=NOT_VERIFIED`

`R4_STAGING_INPLACE_GO=false`

`R5_ACCEPTANCE_PASS=false`; `R6_PRODUCTION_INPLACE_GO=false`; `PR359_MERGE_GO=false`.

This document and the read-only checker do **not** initiate a migration or authorize destructive staging changes. Re-capture and sign the final live metadata against the exact implementation SHA before any approved application.
