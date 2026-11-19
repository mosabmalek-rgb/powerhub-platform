# PowerHub PR #359 — R0 isolated Supabase service-stack discovery and early source-export gate

**Date:** 2026-11-19  
**Scope:** Read-only hosted-source metadata + independent disposable local test.  
**Phase:** `R0_ACCEPTED=false`, `R1_STARTED=false`, `PRODUCTION_SHADOW_UPGRADE_PASS=false`, `PR359_MERGE_GO=false`. No hosted DDL, DML, user/session edits, SMS, merge or deployment.

## 1. Verified preceding CI evidence

At commit `748b2ab9f87ebd5c50ec8075a62aa9632189d1a1`, five core workflows passed, plus the Docker Shadow smoke job. The protected full Docker restored-finance job failed at the expected `verify-managed-catalog-pre-application` stage: hosted 386 managed columns, isolated standalone Docker 39; 348 missing columns, one unexpected `auth.users.email_change_token`, no type mismatches, 35 missing managed tables. The failure did **not** show a financial regression, because no application schema/data was imported.

This failure indicates the local `supabase/postgres:17.6.1.155` database container **alone** does not provide the hosted Auth, Storage and Realtime service migration baseline. Patching isolated Auth audit metadata did not solve general service drift.

## 2. Implemented early guard, not a bypass

`scripts/pr359-shadow/run.sh` now starts the same **networkless** disposable Supabase PostgreSQL image and performs all source-managed schema and service-ledger checks **before exporting business or role/schema/ledger dumps**. Source SQL for this check is metadata-only and read-only.

The pre-export check is intentionally expected to fail for the current incomplete container and to avoid repeated large business-data export operations until service compatibility is proven. The same checks remain installed before and after app schema restoration as defense in depth. No provider-managed schema discrepancies are ignored or auto-generated.

`scripts/pr359-shadow/readiness.test.mjs` enforces pre-export gate ordering.

## 3. Independent full local service-stack experiment

Created:
- `scripts/pr359-shadow/local-stack-probe.sh`
- `.github/workflows/pr359-local-supabase-stack-probe.yml`

This separate **exploratory** workflow uses pinned Supabase CLI `2.122.1`, initializes a unique temporary local Supabase project with **no PowerHub migrations or seed**, and attempts to start provider services in Docker on an isolated bridge network bound to `127.0.0.1`. It rejects any inherited hosted database secrets, inspects published container host IPs, retrieves only the localhost DB URL without printing it, then runs the existing metadata-only queries for managed columns and migration ledgers. It emits aggregate counts and removes temporary containers/volumes/network on exit.

It is triggered only by changes to the probe files or manually; it is **not** a replacement for the protected full restore workflow, it has no Production/Staging credentials and does not claim parity just because services start. CLI flags are verified with `--help` in CI.

**Caution:** The new probe is experimental and must be evaluated from its actual workflow logs. A successful local stack is a candidate for service compatibility only; source-ledger and catalog equality, Auth runtime, roles, extensions, partition lifecycle and full data restore are still independent acceptance requirements.

References: https://supabase.com/docs/guides/local-development/cli/getting-started and https://supabase.com/docs/guides/local-development .

## 4. Next decision checkpoints

- Review the local-stack workflow's startup, isolation and service-schema counts. Address any CLI or Docker errors without weakening isolation.
- Compare this independent local service baseline against source-managed Auth/Storage/Realtime exact migration and catalog evidence. Do not normalize Realtime partitions unless partition parent/limits/ownership are verified separately.
- If the local stack is incompatible, pin a provider-compatible service migration bundle or investigate an isolated full Supabase stack version pair rather than guessing DDL.
- Once compatible, integrate protected source restore into disposable copies, verify two independent upgrades and a controlled rollback/recovery; only afterward consider R1 acceptance gates.
- Continue independent P0 work for 19 Staging-missing runtime RPCs,  SECURITY DEFINER audit and migration Epoch v2 canonical ownership classification.

**No changes to linked Staging or Production and no authorization for rebaseline.**
