# PowerHub — Financial reporting Phase 2 and independent acceptance Phase 3
**Execution baseline:** 2026-11-09 · PR #359 · Staging only · no Production migration or PR merge.

## Verified evidence in this round
- PR #359 is OPEN / DRAFT / unmerged at the readback, initial head `af4621e3a12e287ecd671c33821b237bb92852e3`.
- Four workflows on that **initial** SHA were successful: PowerHub CI, Reading Cycle PostgreSQL Integration, PowerHub Security, Supabase Admin Guard. They **must be rerun/checked on subsequent commits**.
- Vercel preview `powerhub-platform-oih0099jx-mosabmalek-rgb.vercel.app` was READY and associated with that initial SHA. This is a deployment status, **not** authenticated browser acceptance.
- Staging migration ledger includes the financial migration versions `20261109170000` through `20261110004000`, including source-detail fingerprint and reversal recovery. Never replay a recorded version blindly.
- Staging read-only inspection: `financial_accrual_journals` has **0** persisted rows and `financial_accrual_period_reviews` has **0** persisted rows. Existing rollback-only SQL tests are historical evidence, not persisted real-user acceptance.
- Read-only structural audit SQL: `docs/security/sql/pr359-financial-close-readonly-acceptance.sql`. A zero-row result must report **NOT_TESTED**, never PASS.
- No production data or migration was changed in this round.

## Accounting decision gates (blocking)

### A. Recognition and cutoff
Before calling the output a formal income statement, define a versioned service-recognition policy and demonstrate:
1. A service cycle crossing two Gaza-local calendar months is allocated to each month under a documented, consistently applied basis. A completed-cycle-at-end report remains an **indicative billed-service view** only.
2. Earned-but-unbilled service is accrued once, and later invoicing clears that accrual without a second revenue event.
3. Prepayments/unearned portions are liabilities until earned; cancellation, discounts, reversals and tax are reconciled.
4. Revenue journal totals agree independently with invoice/services supporting schedules and the general ledger; the actual source timestamps and time zone are recorded.

### B. Complete and reconciled expense recognition
Gross approved payroll, cash payouts, deductions and advances must reconcile; purchases of stock are assets until qualified consumption; returned/voided movements must reverse cost once. Asset registers, depreciation, provisions, supplier accruals and non-operating items need source-backed schedules and posted entries. No invented zero amounts to fill unknowns.

### C. General-ledger and opening-position gate
Maintain a tenant-scoped, site-aware chart of accounts, opening balances, journal postings and source-to-GL references, with one posting per business event and idempotent reversals. Reconcile:
- Trial balance: total debit balances = total credit balances.
- Balance sheet: **assets = liabilities + equity**, with retained earnings sourced from reconciled P&L (not introduced as a fabricated balancing plug).
- Bank/cash accounts, receivables, payables, inventory, fixed assets, deferred revenue, tax, payroll liability and equity versus their independently produced supporting schedules.
- Multi-site consolidation: eliminate internal transfers and cross-site duplicates; site-level reports must not claim that shared/central costs are assigned without a documented allocation policy.

If any mandatory source, opening balance, GL posting, or reconciliation is unavailable, the report is **incomplete**, not a balanced final statement, regardless of whether a formula happens to net to zero.

## Phase 2 report contracts

| Report | Minimum input | Required output | Fail-closed conditions |
|---|---|---|---|
| Income statement | Period, one site or explicitly authorized tenant consolidation, policy version | service revenue, adjustments, cost of service, gross margin, operating expenses, depreciation/provisions, non-operating items, tax, net result, source references | missing accrual, unclassified stock, unbalanced/unposted GL, incomplete recognized revenue |
| Balance sheet | Exact Gaza-local as-of date, opening journal and complete ledger | cash/bank, A/R, inventory, advances, fixed assets net, liabilities, deferred income, capital, retained earnings, trial-balance link | nonzero unexplained balance difference or missing accounts/schedules |
| Branch profitability | Site + period and documented allocation rules | direct revenue/cost, directly attributed margin, separate allocated overhead and resulting branch result | an unassigned shared cost presented as zero, out-of-scope site, duplicate group consolidation |
| Comparisons | Two matching recognition-policy versions and period boundaries | current/prior and amount/percentage delta, change of status and accounting-policy version | one period incomplete or different policy not disclosed |
| Export | Identical server snapshot/report ID, currency and filters | Arabic RTL PDF and Excel/CSV with run time, period, site, policy, certification state, source fingerprint and page totals | stale snapshot, partial page, failed query, unauthorized site, truncation, discrepancy between on-screen and exported totals |

Do not replace accounting with the existing operational cash-flow or issued-invoice graph. Report fetching/export is opt-in and may not delay ordinary single-site dashboard navigation.

## Phase 3 independently repeatable release matrix
- Two distinct authorized Staging users: maker creates draft; checker posts; maker cannot self-approve; reversal/void are tested in real UI, with the true server response.
- Site A and Site B under same tenant; unauthorized cross-tenant, unauthorized cross-site, and direct tRPC/API bypass are rejected, not hidden only in the UI.
- At least two **independent PostgreSQL connections** race on post-versus-post, close-versus-post, reverse-versus-reverse, and close-versus-reversal. Confirm one committed outcome, explicit loser error/idempotent replay, zero double effect, and a regression fixture.
- Test service spans at 28/29 February, March DST/time-zone transitions and midnight month end; cancellation/reissue, partial receipts, tax, credit note, unbilled service, stock return, payroll advance and depreciation.
- Test multi-site consolidated totals versus individual site totals, shared expenses, and inter-site transfers; reconciliation and export equality.
- Use increasing invoice and account-movement datasets, compare query plans, runtimes and memory; include existing >6,000 invoice fingerprint fixture and high-volume company-account movements. Never silently cap source rows.
- Authenticated Preview browser test on the **new** SHA with two users and role boundaries; reload, stale/failed API path, PDF/CSV export integrity, and real UI validation. Vercel READY alone is insufficient.
- Final four CI gates on **identical final head SHA**; verify branch-preview Staging credentials including independent verification of service-role project association before using privileged Preview operations.

## Explicit release status
- Engineering foundation of Phase 1: verified in preceding handoff.
- Phase 2 income statement / balanced position / branch profit / comparisons / professional export: **NOT ACCEPTED**; requirements documented, implementation and accountant reconciliation remain open.
- Phase 3 browser, independent concurrency and final CI: **NOT ACCEPTED**.
- Do not set `isFinalProfit=true` or `isCompleteAccrualStatement=true` until all blocking accounting evidence is attached.
- Keep PR #359 Draft; do not merge or apply changes to Production without explicit approval.
