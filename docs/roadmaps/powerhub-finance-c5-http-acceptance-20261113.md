# PowerHub — C5 authenticated HTTPS close-readiness acceptance

**Started:** 2026-11-13. **Status:** read-only harness and simulated-transport regression prepared; **live HTTP acceptance NOT_EXECUTED**. This does not certify accounts or approve an accounting period.

## Scope

`scripts/c5-close-readiness-http-benchmark.mjs` tests the new `powerhub.reports.accrualCloseReadiness` read-only tRPC route on a SHA-matched Staging Vercel Preview. It reuses B5's strict Preview hostname validation, authorized bearer token, existing bound test device UUID, readiness preflight, 8000 ms per request timeout, nearest-rank p50/p95/p99, warmups and a hard stop after any failing batch.

- Exact tenant/site/period, one correctly authenticated device; no bypass of the single-device lease.
- Exact response contract: `NOT_CERTIFIED`, `isFinalFinancialStatement=false`, `canAutomaticallyLock=false`, `needsIndependentReviewer=true`, `sourceSnapshotAtomic=false`, `requiresLiveRevalidationAtLock=true`.
- Explicit accepted state `BLOCKED` / `REVIEW_REQUIRED` / `READY_FOR_INDEPENDENT_REVIEW` / `LOCKED_NOT_CERTIFIED`, with valid blocker and review-requirement structures.
- Stable status/blocker fingerprint across the HTTP sample, excluding volatile timestamps; unexpected changes fail acceptance.
- A `PASS` requires exactly the requested valid sample count (100–400), zero errors and p95 within a **separately approved C5** threshold. The earlier B5 <=3000ms bound does **not** automatically certify this new endpoint.
- Only HTTPS `GET` requests. Never perform review-save, lock, source posting, payroll approval, money movement or SMS. Output omits credentials and financial amounts.

## Operator invocation

Set the following environment values privately in the authorized Staging testing context; never paste them into the PR discussion or logs:

`POWERHUB_C5_PREVIEW_URL`, `POWERHUB_C5_ACCESS_TOKEN`, `POWERHUB_C5_DEVICE_ID`, `POWERHUB_C5_TENANT_ID`, `POWERHUB_C5_SITE_ID`, `POWERHUB_C5_PERIOD`, `POWERHUB_C5_P95_BUDGET_MS`, optional `POWERHUB_C5_SAMPLES` / `POWERHUB_C5_CONCURRENCY` / `POWERHUB_C5_EXPECTED_STATUS`.

Execute:

```sh
node scripts/c5-close-readiness-http-benchmark.mjs
```

The result has a status and exact p50/p95/p99/max, attempted/valid count, non-200 errors, timeout counts and zero financial writes. It is not live evidence until run with a real authorized Staging session and recorded SHA.

## Release prerequisites

1. All GitHub checks green on final PR SHA.
2. Apply exactly `supabase/migrations/20261113203000_powerhub_financial_c4_period_close_integrity_guard.sql` using the protected versioned Staging release workflow, then verify migration ledger, ACL and `C4_SOURCE_LOCK_MAKER_CHECKER_REPLAY_PASS_ROLLBACK` on installed schema.
3. Consolidated READY Preview on exact PR code SHA, connected to Staging.
4. Real authenticated HTTP benchmark and scoped UI inspection of blocker/permission denial, error and stale-state handling; do not reuse mock transport as live proof.
5. Record exceptions: owner-waived two-account Preview test is `WAIVED_BY_OWNER / NOT_EXECUTED` only; all server/DB maker-checker guards remain mandatory.
6. Confirm GL unchanged and no artificial approvals. No PR merge / Production until separate acceptance and authorization.

**Phase C final disposition:** `C_FINAL_ACCEPTANCE=OPEN`; `ACCOUNTING_CERTIFICATION=NOT_CERTIFIED`.
