# PR #359 — Staging migration approval request and release gate

**Status: NOT READY FOR APPLY — approval must remain blocked**

This document is the release decision for the seven security migrations in PR #359. It is intentionally a gate record, not authorization to execute SQL. No Staging or Production database was modified while producing it.

## Current verified release snapshot — 8 November 2026 (after Codex commits)

- GitHub PR #359 HEAD: `40d010a3d9564d4c3fb59629e9f99cd90c340c96`; `OPEN / DRAFT / mergeable=true`, `behind main=0`. Prior `CONFLICTING` / not-mergeable claims below are archived historical evidence, **not the current gate**.
- Four required PR workflow runs on this SHA are completed successfully (PowerHub CI, PostgreSQL Integration, PowerHub Security, Supabase Admin Guard). This is an immutable SHA observation, not blanket release approval.
- Fresh read-only Supabase migration-ledger query: Staging 424 rows and Production 486 rows. None of the seven 7-November security migration versions is registered. Staging has the existing 20261105150631 Chat trigger EXECUTE revoke; Production does not.
- Crosswalk name lookup: all 28 requested names are present in Staging (29 rows; `powerhub_reading_opening_baseline_save_fix` has two versions); six names are present in Production (six rows). Of the 29 Staging rows, **zero** retained SQL SHA-256 hashes match a source file in the crosswalk. Five of six Production rows also differ; the remaining `powerhub_owner_capability_overrides` has the same SQL SHA-256 as a source file but a **different version**. Do not classify any case as historically reconciled based on its name or hash alone.
- The [crosswalk JSON](pr359-migration-history-crosswalk-20261108.json) now retains read-only observed `staging_rows` and `production_rows`; each `outcome` remains `NOT_PROVEN` pending version/name/SQL and object-level postconditions. No database writes were made for these observations.
- **Approval remains BLOCKED** by 28 unresolved cases, SQL/version history differences, deployed consumer/API acceptance, security preflight and the required explicit user authorization; the former Git merge conflict is no longer a blocker.

## Historical review snapshot (retained for audit; superseded where noted)

## Current source-only follow-up — 8 November 2026

See [engineering verification](pr359-engineering-verification-20261108.md) for
the fetched `83633d7c` baseline, immutable seven-file hashes, actual disposable
PostgreSQL results and release-race repair. The older conflict statement below
is a historical snapshot: the current fetched branch includes current `main`.
Direct GitHub HTML subsequently confirmed Draft state and green same-SHA CI
on implementation commit `f9f32ee2`; exact run links are in that verification.
The API remains blocked and mergeability was not independently refreshed. See the [application/recovery package](pr359-staging-security-recovery-20261108.md)
for read-only preflight SQL, locking risks and recovery boundaries.
No fresh live database evidence is available. Approval
remains blocked; this follow-up does not authorize any database application.

## Scope

Repository: `mosabmalek-rgb/powerhub-platform`

PR: `#359`

Branch: `feat/auth-local-first-single-pr`

Pinned source HEAD reviewed: `ffaf5378fbd93cd31382f87296bd50428bb65be7`

The seven migrations are:

1. `20261107120000_powerhub_inventory_supplier_site_rls_scope.sql`
2. `20261107130000_powerhub_inventory_phase_d_supplier_allocation_scope.sql`
3. `20261107130443_powerhub_platform_support_identity_role_guard.sql`
4. `20261107140000_powerhub_inventory_supplier_payables_allocation_scope.sql`
5. `20261107143819_powerhub_company_account_capability_search_path.sql`
6. `20261107150000_powerhub_supplier_browser_read_acl_revoke.sql`
7. `20261107150951_powerhub_public_default_privilege_hardening.sql`

## Evidence collected

### Source and CI

- `pnpm check`: PASS in an isolated worktree at the pinned HEAD.
- `pnpm test`: PASS in an isolated worktree at the pinned HEAD.
- GitHub checks on the same SHA: PowerHub CI, PowerHub Security, PowerHub SBOM, Supabase Admin Guard, and Reading Cycle PostgreSQL Integration: PASS.
- PR remains `OPEN`, `DRAFT`, and `CONFLICTING`; it is not mergeable as of this review. No merge or force push is authorized by this record.
- The PostgreSQL integration workflow references the disposable fixtures for Supplier Site RLS, Phase D/payables allocation, Platform Support Identity, Company Account capability, and Default Privileges. The source migrations contain preflight/postflight assertions.

### Live migration ledgers (read-only)

- Staging project `iyuryuhaylhisjfcrwkz`: 424 rows, latest `20261106224902`.
- Production project `vvcdiqcyhaloxesvpppc`: 486 rows, latest `20261026102654`.
- None of the seven canonical 7-November migration versions is present in either ledger.
- Staging does contain `20261105150631_powerhub_chat_trigger_function_exec_revoke`; Production does not. Production consequently still exposes `anon`/`PUBLIC` execute privileges on the three private Chat trigger helpers. This is a real Production parity blocker, not a reason to create a duplicate migration.

### Live object evidence

- Staging already has branch-aware RLS policies for the supplier purchase, receipt, payment, allocation, and ledger tables. The supplier catalog remains intentionally tenant-scoped.
- Staging supplier headers and details have browser SELECT at the table ACL layer; the proposed Supplier Browser ACL migration is therefore still meaningful and must be tested as a direct PostgREST denial plus service-role server-path preservation.
- Both Staging and Production currently retain broad PostgreSQL default ACLs for `anon` and `authenticated` under the `postgres` owner on public tables, sequences, and functions. This is a future-object exposure risk, not proof that existing RLS-protected objects are currently readable. The Default Privileges migration must be applied only after its full preflight passes.
- The existing private `powerhub_has_platform_capability(text)` helper is SECURITY DEFINER and pinned to an empty search path in both snapshots. Its Staging source contract is extended by the new migration to require an active `users.role='admin'` identity; the live migration is not yet recorded.
- Provider-managed `pg_net` ownership and scheduler objects were not changed and must remain outside this release.

## Why approval is blocked

1. [Historical blocker — resolved as of HEAD `40d010a3`] The PR had been conflicting with `main`. Current GitHub verifies `mergeable=true` and `behind main=0`; this is not a remaining release gate.
2. The 28 version-drift groups remain `NOT_PROVEN` pending object-level postcondition evidence. They must not be silently classified as applied and must not be replayed.
3. Production has a confirmed parity gap for the existing Chat trigger ACL migration. This must be handled through the normal canonical release sequence, not by an ad-hoc SQL patch or duplicate migration.
4. The seven migrations have not yet received a live Staging apply and post-apply verification. CI success is necessary but not sufficient.

## Required approval sequence after blockers are closed

1. Re-run the exact-content/version/name release guard against the current ledger and source HEAD.
2. Obtain maintainer approval for one migration at a time through the protected `supabase-staging` environment.
3. Dispatch the versioned migration release workflow from `main`, with `target=staging`, the exact one-file `migration_path`, and `source_pr_number=359`.
4. Apply in dependency order: Supplier Site RLS; Phase D allocation; Platform Support Identity; Supplier Payables; Company Account search path; Supplier Browser ACL; Public Default Privileges.
5. After every file, read back the exact `version`, `name`, and stored SQL payload from `supabase_migrations.schema_migrations`; then run that migration's postconditions before proceeding.
6. For the Supplier ACL migration, verify direct browser denial and service-role server access without using real business data.
7. For Default Privileges, verify future-object inheritance in an isolated disposable database and inspect live `pg_default_acl`; do not modify Supabase-managed `supabase_admin` defaults or provider-owned `pg_net` ACLs.
8. After the seven files, re-run the full read-only catalog comparison, the 28-case crosswalk, and the five CI gates on the resulting immutable SHA.

## Explicit non-actions in this review

- No `apply_migration`, `supabase db push`, direct DDL, or migration-ledger write.
- No Production change.
- No data, SMS, financial, storage, Auth, Cron, or `pg_net` operation.
- No migration rename, replay, deletion, or manual history repair.

**Decision (historical snapshot):** keep the Staging release request blocked until the PR conflict and 28-case reconciliation gate are resolved. The seven migration files and their isolated tests are suitable for review, but the evidence does not authorize live application yet.
