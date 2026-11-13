# PowerHub — C6 independent-session close acceptance

## Goal and scope

A **disposable PostgreSQL 17** integration gate checks the actual versioned C4 writer, not just a mocked React authorization test. All test rows are in the isolated CI database `financial_c6_two_session_close_test`; the script refuses Staging/Production host and database names. This does not touch Staging ledger, Production, or real financial approvals.

### Test files
- `supabase/tests/financial_c6_two_session_close_setup.sql`: minimal independent tenant/site/user/source fixture, actual `20261113203000_powerhub_financial_c4_period_close_integrity_guard.sql`, canonical source-fingerprint review-status function body, and two test months.
- `supabase/tests/financial_c6_two_session_close.sh`: separate PostgreSQL backend PIDs race on the **same actual advisory lock**. A coordinator holds the per-month lock while two authorized checker IDs attempt a close on September 2026.
- `client/src/components/finance/AccrualAccountingPanel.c3.ui.test.tsx`: React UI contract tests for `BLOCKED`, `REVIEW_REQUIRED`, `READY_FOR_INDEPENDENT_REVIEW`, `LOCKED_NOT_CERTIFIED`, authorization error with stale query data, in-flight refetch, and locked-period drift.

### Required evidence
1. **Exactly one** independent checker must close. The other checker receives `PERIOD_ALREADY_LOCKED`.
2. Different `pg_backend_pid()` for both contestants, same isolated tenant and site.
3. The maker cannot self-approve; same-winning-checker replay reports `alreadyLocked=true`; losing checker replay still refused.
4. The C4 writer rejects a distinct older month containing an invalid invoice source; that review remains draft.
5. A post-lock synthetic source revision triggers `driftDetected=true` via source fingerprint. No `isCertifiedProfit=true` claim.
6. Cross-tenant use of the target site is refused by the database.
7. Every untrusted UI state denies an actionable close; a clean draft merely exposes the existing approval action, which is still governed by server RBAC and database maker/checker.

### Boundaries

The source fixture is intentionally minimal, not all production tables or operational source writers. Post-lock drift **detection** is verified; prevention of every source mutation after close is **not** established. The C2 readiness endpoint still performs separate reads, not one atomic snapshot; the C4 writer recomputes within its locked transaction. Further adversarial source-writer races remain separate from journal/close serialization.

CI success will prove the disposable PostgreSQL race and mocked React states, **not** four live authenticated UI states in Preview. Staging `C4` migration is already registered from the protected environment release and real `C5` passed on `d2d88d8c`: 100/100, concurrency 4, p95 648.3ms, zero errors. Results of any new commit must be revalidated on its own SHA; no fake carry-over of a live HTTPS benchmark. `ACCOUNTING_CERTIFICATION=NOT_CERTIFIED`, PR #359 Draft/unmerged; Production unchanged.
