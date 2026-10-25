# Supabase migration release procedure

## Why this exists

The Supabase MCP `apply_migration` operation generates its own migration version at execution time. It does not accept the timestamp prefix from a repository filename. That caused the database DDL to be applied under one version and then required a separate manual edit to `supabase_migrations.schema_migrations.version`. **Do not repeat that workflow.** Manual ledger edits can make the history claim that a different migration ran.

This repository also contains several legacy migration filename collisions. They are pinned in `scripts/check-supabase-migration-files.mjs`; they must not be silently renamed or overwritten because a rename could change the meaning of an already-applied release history. New migrations must have a unique 14-digit timestamp version.

## Standard release path

Use the manual GitHub Actions workflow **Supabase Versioned Migration Release** on `main`. It accepts one exact migration path and one target (staging or production), validates the filename and project reference, takes a PostgreSQL advisory lock, applies the migration body, and writes the same version and suffix-derived name to `supabase_migrations.schema_migrations` in the **same database transaction**. For a pre-merge staging release, provide the number of an open, same-repository PR targeting `main`; the workflow verifies the PR's current base/head, pins the source to its immutable head SHA, and copies only the one newly added SQL migration into the trusted `main` release workspace. Release scripts/helper code always come from `main`, never from the PR branch. Unmerged PR sources are rejected for production. It is safe to rerun an already-recorded migration only when both version and name match. A version/name mismatch fails closed and is never auto-repaired.

The workflow validates both `SUPABASE_PROJECT_REF` and the actual connection URI: it requires the direct host `db.<selected-project-ref>.supabase.co` and database path `/postgres`, so a correctly named project-ref secret cannot mask a mismatched database URL. It also resolves the selected migration to a regular, non-symlink SQL file that is a direct child of the repository's canonical `supabase/migrations` directory; traversal paths, nested files, and symlink targets are rejected before the database connection is opened. It deliberately applies one SQL file, not every pending migration. It refuses non-transactional statements such as `CREATE INDEX CONCURRENTLY`; such work requires a separate reviewed runbook. Migration SQL must not contain psql meta-commands or its own transaction boundaries.

### One-time GitHub environment setup

Create GitHub Actions environments:

- `supabase-staging`: set environment secrets `SUPABASE_PROJECT_REF=iyuryuhaylhisjfcrwkz` and `SUPABASE_DB_URL` to the staging project's direct PostgreSQL connection URI. Configure required reviewers for this environment, so pre-merge staging releases have an explicit human approval gate.
- `supabase-production`: set environment secrets `SUPABASE_PROJECT_REF=vvcdiqcyhaloxesvpppc` and `SUPABASE_DB_URL` to the production project's direct PostgreSQL connection URI. Configure required reviewers, restrict deployment branches to `main`, and require a backup/restore check before approval.

Use a least-privilege database credential appropriate for reviewed schema changes, retain TLS (`sslmode=require`), and never put connection strings in source control or workflow inputs. The workflow verifies the project reference against the selected target before opening the database connection. Repository/environment secrets cannot be populated by a source-code change; the environment setup is a required administrator action.

## Release checklist

1. Review migration SQL, dependencies, data impact and its rollback/recovery plan.
2. Run CI, security and isolated PostgreSQL checks on the exact PR head.
3. To validate a migration before merging its feature PR, dispatch this workflow from `main`, select `staging`, provide the exact migration path and source PR number, and obtain approval through the protected `supabase-staging` environment. The workflow verifies the open same-repository PR and pins its immutable head SHA; it permits only a newly added migration, copied as SQL only, while all release tooling remains from `main`. Apply one migration per run, in dependency order.
4. After each run, verify the version/name with `list_migrations` and use read-only SQL to check the actual schema/RPC/RLS/ACL. Do not rerun versions that are already recorded consistently.
5. Validate the relevant application/database paths in staging. If a browser/performance check is explicitly out of scope, leave it marked not run; its removal is not evidence of application acceptance.
6. Only after staging acceptance, merge the grouped feature PR and verify the migration file on `main` is byte-for-byte identical to the one tested on staging. Perform production release from `main` only with protected production environment approval.
7. Never update `schema_migrations` by hand. If a version is missing or mismatched, stop and perform a drift review before further DDL.

This workflow is an explicit-release gate. It does not apply migrations during normal CI runs, PR checks, or Vercel deployment.
