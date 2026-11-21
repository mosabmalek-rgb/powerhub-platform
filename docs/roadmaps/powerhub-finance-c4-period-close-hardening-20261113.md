# PowerHub — C4 financial period-lock source-integrity hardening

Date: 2026-11-13. PR #359. **Engineering proof in Staging rollback only; NOT deployed to Production, NOT accounting certification.**

## Root cause and risk

The preexisting `powerhub_financial_accrual_period_lock` database writer correctly used a per-period advisory lock, reviewer separation and a source snapshot. However, its closing condition enumerated only six operational blocker counts. In particular it did not reject `invalidInvoiceCount`, `invalidExpenseCount`, `invalidPayrollCount`, `invalidInventoryCount`, `crossPeriodInvoiceCount` or `issuedOutsideServiceMonthCount`. A direct authenticated server mutation could therefore rely on this narrower DB guard even while the optional C2 UI preflight showed a blocker. An absent JSON count could also be cast as NULL, silently bypassing an inequality.

## C4 hardening

A versioned repository migration `20261113203000_powerhub_financial_c4_period_close_integrity_guard.sql` keeps the original source-first `powerhub_financial_accrual_period_lock` contract, per-period advisory lock, row-level `FOR UPDATE`, and idempotent same-reviewer replay. It adds:

- Strong tenant/site/user/month input scope and active site check, before lock.
- Explicit `draft` review requirement, unchanged maker/checker separation and Gaza-local period-end restriction.
- Exact source tenant/site/month and never-final accounting flags.
- Existing document-evidence validation at approval time, not just at preparation time.
- Fail-closed numeric type, presence, nonnegative integer and **zero** requirements for all eleven source blocker counts; missing JSON is not interpreted as zero.
- Strict journal draft count and exact balanced debit/credit total checks.
- `REVOKE` from `PUBLIC` / `anon` / `authenticated`, `EXECUTE` retained only for `service_role`. Server still derives the actual current authenticated actor and requires `manageExpenses`.

No generalized GL reversal, automatic approval, new financial source rows or Production deployment is introduced.

## Tests performed

The migration body was compiled and run **inside BEGIN/ROLLBACK on real synthetic Staging**. A rolled-back test produced `C4_SOURCE_LOCK_MAKER_CHECKER_REPLAY_PASS_ROLLBACK`:

- September 2026 clean synthetic period: creator self-approval denied, distinct checker completed test lock, repeat by same checker idempotently acknowledged, other actor replay rejected.
- October 2026: source cutoff mismatch (`issuedOutsideServiceMonthCount=1`) rejected by new DB guard, not only React.
- November 2026: unended period rejected at DB (one uncompleted invoice and one unclassified inventory issue also present).
- Wrong-site request rejected.
- No GL mutation; transaction fully rolled back. Test actors `4` and `260` are fixtures, not real human approval.

The exact reproducible script is `docs/security/sql/pr359-financial-c4-lock-guard-rollback.sql`. Source contracts assert the guards and non-widened ACL.

## Release gates and caveats

1. **The C4 migration is a repository artifact, not yet a permanently applied Staging migration.** Apply it only through the approved exact-version one-file protected release path; confirm matching `supabase_migrations.schema_migrations` version and name first, then execute rollback proof against installed schema.
2. Required GitHub CI must pass together on the final changed SHA.
3. Post-install check that `anon=false`, `authenticated=false`, `service_role=true` and SQL function fingerprint matches expected.
4. Existing source writers outside the period advisory-lock discipline may still update financial source rows after a close; locked-period drift detection therefore remains necessary. Do not claim serializable close across all operational sources without specific concurrency evidence.
5. C2's source reads are not a common transactional snapshot; C2 remains advisory. The database writer is the final mandatory gate.
6. Run authenticated Preview UI/API tests for C2–C4 and failure/retry handling, then representative benchmark. No forced refresh of Preview for every small change.
7. `ACCOUNTING_CERTIFICATION=NOT_CERTIFIED` until documentary source proof and independent human review. PR stays Draft/unmerged; Production unchanged.

**C4 gate today:** `STAGING_ROLLBACK_ENGINEERING_PASS`, `MIGRATION_APPLIED_STAGING=NO`, `C_PHASE_FINAL_ACCEPTANCE=OPEN`.
