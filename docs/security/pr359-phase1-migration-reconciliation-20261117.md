# PowerHub — Phase 1 Migration Reconciliation

**Date:** 2026-11-17
**Scope:** migration-ledger reconciliation and release-gate hardening only.
**Environments:** Staging and Production Supabase catalogs were inspected read-only.

## Decision

`MIGRATION_RECONCILIATION_PASS` is **not granted yet**. The live ledgers contain historical rows whose `statements` payload is unavailable. Those rows cannot be treated as applied merely because their version or name exists.

The release guard now exposes explicit decisions:

- `EXACT_APPLIED`: version, name, and SHA-256 of the retained SQL match exactly. This is the only applied state accepted for an already-recorded migration.
- `MISSING`: version and name are absent. A new reviewed migration may be released through the protected workflow.
- `UNPROVEN`: the row exists but its SQL payload is NULL/empty/unavailable. Release is blocked; schema postconditions and independent evidence are required.
- `DIVERGENT`: the version/name identity or SQL SHA differs. Release is blocked; the source and live schema/history must be reconciled.

No legacy migration ledger row was edited, no historical SQL was replayed, and no live migration was applied by this work.

## Live ledger evidence

| Environment | Project reference | Migration rows | Rows with unavailable/empty SQL payload | Interpretation |
|---|---:|---:|---:|---|
| Staging | `iyuryuhaylhisjfcrwkz` | 553 | 82 | 82 rows are not automatically accepted as applied |
| Production | `vvcdiqcyhaloxesvpppc` | 486 | 3 | 3 rows are not automatically accepted as applied |

Correction: the **12 source migration files with nonmatching Staging ledger versions** are a separate source/history crosswalk from the **12 older Staging rows with missing SQL payload**. The identical counts must not be confused or assumed to overlap. The payload-absence cohort consists of 12 pre-November rows and 70 rows from 2026-11-01 onward; all 82 remain `UNPROVEN` for historical SQL execution. The three Production payload-absence rows form a third group. No historical-application proof follows merely from a matching filename.

## Source crosswalk policy

For each candidate migration, the evidence record must contain at least:

1. source filename and 14-digit version;
2. SHA-256 of the exact UTF-8 source bytes;
3. live ledger version/name;
4. live retained SQL SHA-256, or explicit `unavailable`;
5. postcondition/object evidence for any `EQUIVALENT_PROVEN` decision;
6. the final status and release decision.

A similar name, an empty `statements` array, or a successful historical deployment claim is not sufficient by itself.

## Release-guard implementation

Changed in the isolated PR worktree:

- `scripts/supabase-migration-target.mjs`
  - added `reconcileSupabaseMigrationHistory()`;
  - made the four statuses explicit;
  - retained the fail-closed behavior in `classifySupabaseMigrationHistory()`;
  - preserved the existing requirement that only an exact SQL SHA match is `already-applied`.
- `scripts/supabase-migration-target.test.mjs`
  - added assertions for `EXACT_APPLIED`, `MISSING`, `UNPROVEN`, and `DIVERGENT`;
  - retained regression coverage for malformed, duplicate, unavailable, and mismatched records.

## Validation

- `node --check scripts/supabase-migration-target.mjs` — **PASS**
- targeted Vitest suites — **PASS: 34/34 tests**
  - `scripts/supabase-migration-target.test.mjs`
  - `server/pr359-historical-migration-reconciliation.test.ts`

## Remaining blockers

`PRODUCTION_SHADOW_UPGRADE_PASS` remains **NOT PROVEN**. The available Supabase branch inventory did not provide a verified disposable shadow clone containing a protected copy of Production. A shadow upgrade must be performed only after an isolated database/backup is provisioned and its source, retention, access controls, and cleanup are verified.

Until then, do not apply the 12 historical migrations, do not fill old `schema_migrations` payloads, and do not merge or release a migration whose live status is `UNPROVEN` or `DIVERGENT`.

## Follow-up — 85-item read-only ledger evidence (2026-11-17)

A separate source-pinned snapshot is committed at `docs/security/pr359-phase1-migration-ledger-payload-evidence-20261117.json` (82 Staging + 3 Production). Matching source file paths were checked against the PR diff (70 recent files) and against GitHub file content directly (the 12 older Staging files and three Production files). CI calculates and uploads each exact source SHA-256 in an enriched JSON artifact using `scripts/pr359-migration-evidence.mjs`, without confusing a source hash with the unavailable historically executed SQL. Every row stays `UNPROVEN` pending catalog and behavioral attestation.

The code-only evidence check is **not** `MIGRATION_RECONCILIATION_PASS`. Neither Supabase project has an existing development branch, and an empty schema-only branch is not a Production-derived clone with preserved safe data, extensions and permissions. Protected Production-shadow restore, repeatable upgrade and failure-recovery testing remain unexecuted. **NO-GO stays in force.** No migration, historical ledger edit or Production modification was performed.

## Targeted Production 3/3 missing-SQL catalog probe (2026-11-17)

Evidence: `docs/security/pr359-phase1-production-three-catalog-evidence-20261117.json`; repeatable read-only catalog query: `scripts/sql/pr359-production-three-catalog-audit.sql`. Verified in **both** Staging and Production:

- Trial state columns and trial expiry index exist (4/4 selected columns and 1/1 targeted index); subscription lifecycle cron job is active and scheduled `*/15 * * * *`.
- Operational/financial dashboard RPCs and lifecycle RPC are postgres-owned `SECURITY DEFINER`, with service-role EXECUTE and no anon/authenticated EXECUTE for the selected signatures. The dashboards and lifecycle worker have pinned empty search_path; the duration-aware provisioning overload exists.
- Three targeted indices exist; all five selected function definitions and ACLs were inspected and their live SHA-256 recorded per environment.
- **Material observed drift:** `powerhub_dashboard_financial_overview` has different definition SHA in Staging (`da763042afc1818ea80bdd90e7698913b6a57017eede20e24c7726c8216d9cc8`) versus Production (`37950a1a4c679c074b86e1adf102c5d9d2ea756de356c0247310c74cdc912f3a`). Staging uses `p.invoice_applied_amount` and invoice-purpose restrictions; Production uses `p.amount` without those restrictions. This is **not** a proved end-to-end accounting discrepancy but **is** a reconciliation/release compatibility risk requiring an isolated financial scenario.
- **Historical attribution still `UNPROVEN` for all three Production ledger rows.** Matching current catalog objects are not proof that the absent historic SQL was executed. No Production business row was read or changed and no functions were invoked. A safe Production-derived Shadow rehearsal is still required before release.
