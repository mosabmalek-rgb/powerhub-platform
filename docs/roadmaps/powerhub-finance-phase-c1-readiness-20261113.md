# PowerHub — Phase C1: period close readiness and source-integrity preflight

**Started:** 2026-11-13 | **Environment:** isolated Staging only | **Status:** C1 discovery + first reproducible read-only regression; **not month-end close or financial certification**.

## C1 goal
Build an evidence-driven month-end readiness workflow from existing source-of-truth accrual and general-ledger functions. A missing source, missing evidence, pending journal, unclassified inventory usage, non-final invoice, unmapped opening or a false role may never be rendered as a certified zero or auto-approved close.

## Existing entry points (source-reviewed)
- `powerhub_financial_accrual_month_statement(tenant,site,period,as_of)`: preliminary source-derived monthly financial statement; `isFinalProfit=false` and `isCompleteAccrualStatement=false`.
- `powerhub_financial_accrual_period_review_status(tenant,site,period)`: evidence status `unprepared/draft/locked` and `isCertifiedProfit=false`.
- `powerhub_financial_accrual_period_lock(tenant,site,period,user)`: separate guarded write path. **Not invoked in C1 preflight**.
- `server/powerhub.ts`: authenticated `viewFinancialReports` reads; `manageExpenses` and distinct authorised reviewer requirements for review save/lock.
- On Staging these three SQL functions have `service_role=true`, `anon=false` and `authenticated=false` direct EXECUTE; role and tenant/site authorization remain in the server.

## Actual Staging baseline (tenant 1, site 1)
| Period | Review status | Evidence from preliminary source statement | C1 decision |
|---|---|---|---|
| 2026-10 | `unprepared` | Provisional net **-2928.50**, completed invoices 3, payroll gross 5550; not complete and not final | **NOT_READY**: documentary period review and independent sign-off missing |
| 2026-11 | `unprepared` | **1** uncompleted invoice, **1** unclassified inventory issue, provisional net **-190**, period still in progress at test time | **BLOCKED**: source blockers plus month-end date gate |

These are **synthetic Staging measurements**, not audited financial metrics or Production figures. The close must not infer that any missing category is zero merely because a preliminary report returned an amount.

## First C1 deliverable
- `docs/security/sql/pr359-financial-c1-staging-close-readiness-readonly.sql` contains a **BEGIN TRANSACTION READ ONLY ... ROLLBACK** test that rechecks GL balance, source-derived period and tenant/site scope, exact non-final flags, debit/credit consistency and recorded November source blockers.
- Acceptance marker: `C1_STAGING_READ_ONLY_CLOSE_BLOCKERS_PASS_NOT_CERTIFIED`. This proves the existing **read** preflight against Staging; it does not test closing mutations, an external accountant, different tenant, or live browser experience.
- No schema migration, accounting write, approval, altered permissions, Prod deployment, or Preview generated.

## Next C slices (not yet delivered)
1. C2: server-only unified readiness contract with explicit `BLOCKED/REVIEW_REQUIRED/READY_FOR_INDEPENDENT_REVIEW` and enumerated blockers, validation of all source evidence and no automatic approval.
2. C3: UI that displays source blockers and documentary evidence, last refresh and non-certification; authorization denial must clear scoped stale rows.
3. C4: concurrent close-vs-source-change negative tests, maker/checker, idempotency and replay protection; prevent cross-period/cross-site leakage.
4. C5: authenticated Preview E2E and representative read/write performance evidence without real money transfers; independent human accounting review remains separate.

**Launch boundary:** Phase C may progress while B operational acceptance is documented as OPEN; no one may turn a synthetic preflight into a certified balance, genuine period lock or Production release.
