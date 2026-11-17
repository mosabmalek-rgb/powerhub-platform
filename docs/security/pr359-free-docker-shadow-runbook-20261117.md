# PR359 — Supabase Free: Docker isolated logical Shadow

The owner confirmed Production and Staging contain only prelaunch synthetic/test records. All original hosted database schemas and migration history remain untouched.

**CI smoke** automatically uses an isolated `postgres:17.6` container with `--network none`, executing original historical credit-backfill SQL twice with no duplicate effects and a separate controlled transaction rollback.

**Opt-in source-derived restoration** is disabled until protected repository variable `PR359_ENABLE_PRODUCTION_DOCKER_SHADOW=true` and environment secret `PR359_SHADOW_SOURCE_DB_URL` are configured in GitHub environment `pr359-shadow`. The source is allowlisted to the exact Production project `vvcdiqcyhaloxesvpppc` and requires port 5432, TLS and read-only default SQL. Never disclose the database URI in chat or Git history. A temporary Docker instance with no network and no ports is the only write target.

The protected job attempts separate Supabase logical role, application-schema, data and managed-schema exports, preserving the exact `supabase_migrations` history. It fails closed if any managed objects or baseline row counts differ. It runs the unchanged four SQL files `20261103131052`, `20261103131104`, `20261103131125`, `20261103145232` via `buildSupabaseMigrationTransaction`, twice on independent restores; a third restore injects an exception after SQL body but before ledger insertion and proves rollback and recovery. Any export, extension, role or image incompatibility is a blocker, not a PASS.

**Scope limitation:** Even a passing four-migration Docker finance rehearsal does not resolve the 28 historical mismatch groups, unavailable SQL ledger rows, RLS/functional authorization or external Supabase services. Data in object Storage buckets and external provider state are not in SQL dumps. Both phase-one approval gates stay NO-GO pending the relevant proofs.

Local WSL2 procedure: run `node --test scripts/pr359-shadow/*.test.mjs`, then `bash scripts/pr359-shadow/run.sh smoke`; for opt-in full run set the secret via a local read-s prompt, `SHADOW_APPROVED_HEAD=$(git rev-parse HEAD)`, `SHADOW_CONFIRM_PRODUCTION_TEST_DATA=YES_PRODUCTION_TEST_DATA` and execute `bash scripts/pr359-shadow/run.sh full`. Use GitHub environment protections for CI. Never use the hosted migration release workflow for this rehearsal.

Documentation: https://supabase.com/docs/guides/self-hosting/restore-from-platform
