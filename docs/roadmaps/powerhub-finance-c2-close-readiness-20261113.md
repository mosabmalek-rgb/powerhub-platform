# PowerHub — C2 authenticated month-end close readiness

**Scope:** PR #359, Staging only. This is an advisory read-only preflight, not a certified month-end or Production release.

## Components
- `server/financial-close-readiness.ts` is a pure fail-closed source-validation helper.
- `powerhub.reports.accrualCloseReadiness` is an authenticated, tenant/site/period-bounded protected read with live `viewFinancialReports` authorization. The endpoint reads the pre-existing monthly accrual statement and review-status RPCs.
- `AccrualAccountingPanel` displays reason-coded source blockers and review requirements. The existing lock button is additionally gated by a fresh `READY_FOR_INDEPENDENT_REVIEW` result. This is not a security grant. Existing DB lock checks remain mandatory.

## Four states
- `BLOCKED`: period has not ended in Asia/Gaza, incomplete/invalid/cross-period service sources, unclassified inventory issue, payroll mismatch/draft, journal draft or imbalance, or post-review drift.
- `REVIEW_REQUIRED`: sources are nonblocking, but the review or documentary evidence is incomplete.
- `READY_FOR_INDEPENDENT_REVIEW`: reviewed draft with the required evidence, completed month and no detected source blockers. It authorizes no automatic approval or close.
- `LOCKED_NOT_CERTIFIED`: already locked by the separate database-controlled reviewer pathway; not a certified financial statement.

## Safety contract
- Source scope, expected non-final status, timestamps, counts and report limitations are validated. Missing or malformed values fail closed rather than masquerading as zeros.
- Two Supabase read RPC calls are not a common transaction snapshot; `sourceSnapshotAtomic=false` and `requiresLiveRevalidationAtLock=true`. Database must independently validate current source and actor at lock time.
- Response asserts `accountingCertification=NOT_CERTIFIED`, `isFinalFinancialStatement=false`, `canAutomaticallyLock=false` and `needsIndependentReviewer=true`.
- Does not create a database migration or relax device, tenant/site, ACL, audit, posting, reviewer or period protections.
- Real authenticated Preview acceptance is not demonstrated by mocked UI or CI contracts.

**Baseline:** Phase B report-performance B5 passed on f41f11d0, not automatically transferable to C2. PR #359 stays Draft; Production unchanged.
