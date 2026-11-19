# PowerHub PR359 — R0 Docker-only Supabase Auth type compatibility fix

**Date:** 2026-11-19  
**Scope:** Docker Shadow **disposable network-isolated** tests only, and R0 evidence.  
**Safety:** No linked Staging/Production DDL/DML, schema reset, Auth/Storage mutation, SMS, ledger editing, merge or deployment.

## Verified before the change

The prior PR359 Docker Shadow job `real-restored-finance` failed in `verify-managed-catalog`, with:
- `sourceCols=386`, `dockerCols=39`, **348 missing** and **one different column type**.
- The type mismatch was `auth.audit_log_entries.ip_address`: hosted `character varying(64)`, Docker `character varying`.
- Read-only `pg_catalog` checks independently verified `character varying(64) NOT NULL DEFAULT ''::character varying` for the same column in **both** Staging and Production, owned by `supabase_auth_admin`.
- The existing bootstrap patch uses a local `supabase_admin` superuser only within `docker run --network none`. The source environment uses a read-only connection; it is not a target of the patch.

## Implemented source changes

1. `scripts/pr359-shadow/bootstrap-auth-audit-column.sql`: add missing local-only `ip_address` as **`character varying(64)`** instead of unlimited `character varying`; guard checks `information_schema.columns.character_maximum_length=64`, NOT NULL and expected default. Existing-column type drift still fails closed.
2. `scripts/pr359-shadow/run.sh`: Docker smoke assertion now checks bounded maximum length 64 instead of merely data_type.
3. `scripts/pr359-shadow/check-managed-catalog.test.mjs`: comparator expectations use the hosted `varchar(64)` source type and include regression tests rejecting unbounded `varchar` plus inspecting bootstrap SQL for the exact length/default check.

**Important:** No weakening of `check-managed-catalog.mjs`, no bypass of missing Auth/Storage/Realtime columns. The **348 missing managed columns remain a hard block**. The Docker image uses `supabase/postgres:17.6.1.155` and is missing many managed Auth definitions present on the hosted system. A one-column patch cannot establish full Supabase managed schema parity.

## Acceptance and next steps

- Re-run the **same SHA's** `PR359 Docker Shadow (disposable)` workflow. Expected: isolated smoke guards pass, and the previous unbounded-varchar mismatch no longer appears. It is **not** expected or acceptable to claim full PASS while the other 348 missing columns remain.
- If the image proves incomplete, build a provider-compatible, version-pinned isolated Supabase Auth/Storage/Realtime migration fixture, or use an equivalently verified source-compatible environment, and retain full managed-schema parity checks. Review all provider-managed migrations and image provenance before making any bootstrap adaptation; never guess column sets to make a comparator green.
- Repeat exact source-copy recovery and full financial isolated restore on **two independently recreated copies**, plus a controlled rollback/recovery test only after compatibility is demonstrably solved.
- Keep 19 Staging-missing RPC contracts and Canonical Baseline source/ownership validation open. `R0_ACCEPTED=false`, `R1_STARTED=false`, `PRODUCTION_SHADOW_UPGRADE_PASS=false`, `STAGING_INPLACE_GO=false`, `PRODUCTION_INPLACE_GO=false`, `PR359_MERGE_GO=false`.

The document is an engineering change record, not verification of completed CI nor a certificate that the remote database can be restored.