# PR359 — Supabase Free: Docker isolated logical Shadow

The owner confirmed Production and Staging contain only prelaunch synthetic/test records. All original hosted database schemas and migration history remain untouched.

**CI smoke** automatically uses an isolated `postgres:17.6` container with `--network none`, executing original historical credit-backfill SQL twice with no duplicate effects and a separate controlled transaction rollback.

**Opt-in source-derived restoration** is disabled until protected repository variable `PR359_ENABLE_PRODUCTION_DOCKER_SHADOW=true` and environment secret `PR359_SHADOW_SOURCE_DB_URL` are configured in GitHub environment `pr359-shadow`. The GitHub Action validates the URI format before installing the CLI or contacting the source. Paste the full **Database Connection URI**, not the HTTPS Project URL, into the environment secret. The URI must start with `postgresql://` or `postgres://`, contain the database password (URL-encoded), target port `5432` and `/postgres`. **If Supabase Connect omits `?sslmode=require`, the runner adds it in memory before any connection; TLS remains mandatory.** Any explicitly insecure `sslmode` or unexpected query parameter is rejected. Do not include quote characters, brackets or placeholder text.

The source is allowlisted to the exact Production project `vvcdiqcyhaloxesvpppc` and requires port 5432, TLS and read-only default SQL. Never disclose the database URI in chat or Git history. A temporary Docker instance with no network and no ports is the only write target.

The protected job follows Supabase's documented role, application-schema and data dump sequence (including Auth rows), plus separate migration-ledger schema and data exports to preserve the exact `supabase_migrations` history. It fails closed if any managed objects or baseline row counts differ. It runs the unchanged four SQL files `20261103131052`, `20261103131104`, `20261103131125`, `20261103145232` via `buildSupabaseMigrationTransaction`, twice on independent restores; a third restore injects an exception after SQL body but before ledger insertion and proves rollback and recovery. Any export, extension, role or image incompatibility is a blocker, not a PASS.

**Scope limitation:** Even a passing four-migration Docker finance rehearsal does not resolve the 28 historical mismatch groups, unavailable SQL ledger rows, RLS/functional authorization or external Supabase services. Data in object Storage buckets and external provider state are not in SQL dumps. Both phase-one approval gates stay NO-GO pending the relevant proofs.

Local WSL2 procedure: run `node --test scripts/pr359-shadow/*.test.mjs`, then `bash scripts/pr359-shadow/run.sh smoke`; for opt-in full run set the secret via a local read-s prompt, `SHADOW_APPROVED_HEAD=$(git rev-parse HEAD)`, `SHADOW_CONFIRM_PRODUCTION_TEST_DATA=YES_PRODUCTION_TEST_DATA` and execute `bash scripts/pr359-shadow/run.sh full`. Use GitHub environment protections for CI. Never use the hosted migration release workflow for this rehearsal.

Documentation: https://supabase.com/docs/guides/self-hosting/restore-from-platform


## GitHub-hosted runner IPv4 guard (2026-11-17)

GitHub Actions hosted runners do not support Supabase's default IPv6-only direct database endpoint. The protected job now **fails before network access** with `PR359_SOURCE_IPV4_REQUIRED` if its database URI uses `db.vvcdiqcyhaloxesvpppc.supabase.co`. Set the protected environment secret to the exact **Session Pooler** connection URI from Supabase Production > Connect (username `postgres.vvcdiqcyhaloxesvpppc`, Supavisor regional hostname shown by Supabase, port `5432`, database `postgres`). Do **not** use Transaction Pooler port `6543`. The script normalizes absent `sslmode` to `require`, never accepts `disable`, and prints only categorized (credential-free) errors if the first read-only source check fails. No database secret, hostname or raw libpq stderr is sent to CI artifacts.

Source: https://supabase.com/docs/guides/platform/ipv4-address

## Restored Docker role preflight — 2026-11-17

The first Production-derived logical backup passed remote read-only connection, dump, SQL rendering and Supabase Postgres 17 image pull, but failed while executing `roles.sql` with `ERROR: role "supabase_realtime_admin" does not exist`. The Supabase CLI's `--role-only` export excludes reserved roles, so raw `supabase/postgres` initialization may not reproduce the managed platform role set.

`scripts/pr359-shadow/bootstrap-realtime-role.sql` creates **only** the missing `supabase_realtime_admin` in the disposable `--network none` container before importing the role dump and verifies its exact source-attested role flags: `NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`. Source flags were inspected read-only on project `vvcdiqcyhaloxesvpppc` on 2026-11-17. Existing roles with conflicting flags fail closed. The automatic smoke replays this bootstrap twice, proving it is idempotent.

**Do not** apply this SQL to managed Supabase, copy it into the release migrations, or weaken database privileges. This is a compatibility preflight, not proof of restore equivalence. Remaining reserved roles, extensions, Auth/Storage schema compatibility, migration history and financial acceptance require actual execution evidence.
## 2026-11-17 — Reserved role requires local superuser

The protected source-derived restore run `44132626459` failed after downloading the logical backup and starting `supabase/postgres:17.6.1.155` with `"supabase_realtime_admin" is a reserved role, only superusers can modify it`. The previous local bootstrap had invoked `psql -U postgres`, which **is not a superuser in Supabase Postgres**. This is not an error from financial migration SQL.

The isolated bootstrap now uses `psql -U supabase_admin` **exclusively inside the networkless disposable Supabase Postgres container**. A privilege assertion must confirm `current_user=supabase_admin` with `rolsuper=true` before any privileged role setup. The `roles.sql` dump is also restored locally using this role; subsequent application schema, data, and all four financial migrations still run as local `postgres` to preserve permission checks.

The automatic smoke also starts the **actual Supabase Postgres pinned image**, verifies the local admin privilege and executes the exact reserved-role bootstrap twice to guard against regressions. No unapproved elevated rights, Docker ports or network are introduced. If the privilege assertion or reserved-role policy fails, the run is marked FAIL, not silently skipped.

The Production source connection remains read-only via the protected Supabase Session Pooler. The real restored financial rehearsal still requires a fresh protected approval and must not be reported as accepted until it succeeds.
