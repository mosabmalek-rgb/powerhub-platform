# PowerHub — C acceptance ledger: separated scopes and evidence (13 November 2026)

**PR #359 / Branch:** `feat/auth-local-first-single-pr`.
**Verified final evidence baseline:** `e745c111044c6d1f39c5fc65ee28d601c122a058`.
**Engineering disposition:** `C_CLOSE_SCOPED_ACCEPTED_WITH_OWNER_WAIVERS`.
**Full Phase C per financial master plan:** `C_COMPARISONS_EXPORTS_NOT_YET_ACCEPTED`.
**Financial certification:** `ACCOUNTING_CERTIFICATION=NOT_CERTIFIED`.
**Delivery:** PR OPEN/Draft/unmerged; Production not touched.

## 1. Scope reconciliation with the two plans

**Close-readiness stream C1–C5** in this PR is *not* identical to **"المرحلة C — المقارنات والتصدير"** in `docs/roadmaps/financial-phase2-phase3-acceptance-20261109.md`. These scopes cannot be interchangeable in an acceptance decision.

The engineering close-readiness implementation is accepted **only within its evidenced scope** (Staging provisional accounting, read-only readiness, non-certified review, guarded independent period lock, owner-approved testing exceptions). Do **not** describe it as complete certified month-end accounting.

The master finance Phase C checklist also requires comparable periods and policy provenance, branch/period trends, PDF RTL and Excel/CSV complete exports, source-to-file reconciliation, source snapshot identifiers, pagination, authorization and large dataset downloads. Existing cash-flow compare and administrative PDF/CSV export buttons in `FinancialDashboardPage.tsx` are **partial preexisting functions**; they do not prove all those additional accounting-level acceptance criteria. Consequently **full master-plan Phase C remains OPEN**. Do not quietly amend master-plan unchecked items to PASS.

## 2. Verified engineering gates — closing-readiness stream

| Gate | Evidence | Actual verdict |
|---|---|---|
| C1: source and period readiness | Re-ran `docs/security/sql/pr359-financial-c1-staging-close-readiness-readonly.sql` against Staging on 2026-11-13; returned `C1_STAGING_READ_ONLY_CLOSE_BLOCKERS_PASS_NOT_CERTIFIED`. Includes source blockers, non-final flags, balanced GL and scope. | `PASS_IN_TESTED_SCOPE` |
| C2: protected readiness contract | `powerhub.reports.accrualCloseReadiness` guarded by `viewFinancialReports`; source-shape validation and failure rejection; 5/5 CI on final SHA. Real browser uses authorized tenant 1/site 1, period 2026-11 with `BLOCKED`, not certified. | `PASS_IN_TESTED_SCOPE` |
| C3: visible blocked-state on actual Preview | Site-1 selection corrected; genuine authenticated Preview showed unfinished invoice and unclassified inventory issue, disabled close action, preliminary/unapproved statement. | `PASS_BLOCKED_VARIANT_ONLY`; remaining four-state/revocation tests waived below |
| C4: installed DB lock and access | Protected Staging workflow #43 `43490929743` applied exact migration `20261113203000_powerhub_financial_c4_period_close_integrity_guard`. Confirmed ledger + `anon=false`, `authenticated=false`, `service_role=true`. Re-ran installed-schema `docs/security/sql/pr359-financial-c4-lock-guard-rollback.sql`: `C4_SOURCE_LOCK_MAKER_CHECKER_REPLAY_PASS_ROLLBACK`. Sequential maker/checker, self-approval rejection, same-reviewer replay, site scope, cutoff and unfinished month, zero saved financial approvals. | `PASS_SEQUENTIAL_ROLLBACK_SCOPE` |
| C5: authenticated browser HTTPS | [PR proof](https://github.com/mosabmalek-rgb/powerhub-platform/pull/359#issuecomment-6863164959); deployed Preview `dpl_CNNaifoscEYgkiXdLkXT3nUaWQBw` on code commit `d2d88d8c0d973638ffc3f0c8c9d1f6cbe2254233`. 100/100 correct GET, concurrency 4, p50 392.6ms, p95 **648.3ms**, p99 814.5ms, maximum 946.4ms, 0 errors/timeouts, accepted budget p95 ≤3000ms. No writes or credential exposure. | `C5_AUTHENTICATED_HTTP=PASS` on tested code SHA |
| Current CI | Five workflows all `SUCCESS` on **e745c111044c6d1f39c5fc65ee28d601c122a058**: PowerHub CI, PostgreSQL Integration, Security, Admin Guard and B5 Synthetic Financial Load. | `CI=PASS` on final evidence SHA |
| Current Staging ledger | Direct read-only SQL: 25 GL entries / 51 lines, debit=credit=18,073.50, 0 stored review approvals. C4 migration installed. | `BASELINE_PRESERVED` |
| PR technical discussion | Nine of nine review threads resolved, no APPROVED review recorded; PR remains Draft. | `REVIEW_THREADS_RESOLVED_NOT_MERGE_APPROVED` |

The last commit `e745c111` changed only test/waiver documentation tree relative to the C5-tested runtime SHA, not the C2/C3/C4/C5 application runtime. Real HTTPS acceptance is *not* automatically extended to any future runtime-modifying commit.

## 3. Explicit owner waivers — never PASS

Source: `docs/roadmaps/powerhub-finance-phase-c-owner-waivers-20261113.md` and [PR record](https://github.com/mosabmalek-rgb/powerhub-platform/pull/359#issuecomment-6863528811).

- `C6_TWO_INDEPENDENT_POSTGRES_SESSION_CLOSE_RACE=WAIVED_BY_OWNER_NOT_EXECUTED`: no positive claim about two-backend close/source-writer serializability.
- `C3_FOUR_UI_STATE_LIVE_AND_STALE_ERROR_TESTS=WAIVED_BY_OWNER_NOT_EXECUTED`: only actual `BLOCKED` state is browser-proven, other states and stale-result/revocation scenarios are not live-accepted.
- Previously waived two-independent-account Preview exercise remains `WAIVED_BY_OWNER_NOT_EXECUTED`; server/DB tenant/site and maker/checker protections remain mandatory.

No disabling of the actual database guard, period advisory lock, one-device policy, ACL, RBAC or idempotency. **Waiver does not eliminate risk**: log these as explicit residual release risks.

## 4. Outstanding acceptance per master Phase C plan (comparisons and exports)

1. Same-policy comparative accrual periods, correct percentages with denominator zero, transparent status and Gaza-local cutoff.
2. Source-backed period/site trend and branch comparison (only for entitled multi-site subscriptions), on-demand with server-side full aggregates rather than first-page browser totals.
3. PDF Arabic RTL and Excel/CSV exports including identity, tenant/site, period, currency, filters, policy version, non-certification, generation time, snapshot identifier, pages and footers.
4. Exact UI/export/GL source reconciliation, refusal of stale, incomplete, unauthorized or cross-tenant exports; large multi-page download and performance regression.

Existing administrative PDF/CSV and cashflow UI are not substitutes for the above accounting-level tests. **Do not announce blanket `PHASE_C=PASS`**.

## 5. Release and sign-off boundary

- Scoped close-readiness engineering acceptance is **recorded** with waivers; it is not accounting approval or full feature-complete according to `docs/دورة التطوير باستخدام شات جي بي تي.md`.
- Human review of documentary opening balances, depreciation, provisions and certified profit is still `NOT_CERTIFIED`.
- The master-plan Phase C comparisons and exports remain open.
- Production release, PR merge, formal accounting sign-off and user-facing claims of certified profit remain prohibited absent their independent gates and approval.


## 6. Master C implementation slice (2026-11-13, initial code state; superseded by section 8)
- Code commit `ac843b09eb06d53c910f24a12fb3c81e95b04f18`: PostgreSQL GL two-period snapshot, server permission guard and fresh-fingerprint export precondition. These are new work, **not** C1–C5 acceptance evidence.
- Migration `20261113204500_powerhub_financial_gl_monthly_comparison_c` was **NOT YET APPLIED at this initial implementation timestamp**; section 8 records the subsequently verified Staging installation.
- The SQL reads complete published GL aggregates and proves matching service-recognition policy versions by source type. Missing prior-period recognized service, missing coverage, or unbalanced posted entries block export rather than manufacturing zero or a percentage.
- Comparison is allowed to display provisional values with clearly flagged blockers; only provably comparable current/previous periods can be exported. All results are `NOT_CERTIFIED`.
- The export action always re-reads the server-side source and verifies the requested snapshot fingerprint. No browser-side paging sums or cross-site access.
- **Acceptance gates remain OPEN** pending: TypeScript/tests/CI on final head, protected Staging migration, real RPC SQL proof, authenticated HTTPS and download/PDF/Excel multi-page verification, large-volume/performance, and multi-site trend acceptance. No claim of `MASTER_FINANCE_PHASE_C=PASS`.


## 7. Phase C month/site trends, source-only implementation
- Added full PostgreSQL site/month aggregates for 1–12 months, maximum 30 authorized active sites, no first-page client aggregation, no fetching at ordinary dashboard load.
- Multi-site comparison requires the tenant multi-branch entitlement and independently verified report access to **every** active site; one-site subscriptions see no multi-site comparison choice.
- Every period keeps missing-posting/policy states visible, and the trend is explicitly \`PRELIMINARY_GL_TREND_UNVERIFIED_SOURCES\` with \`NOT_CERTIFIED\`. It is not a source-reconciled export, certified profit, or consolidated financial statement; central costs are not silently allocated.
- The implementation is a source-code delivery pending newest-head CI, the protected exact migration \`20261113204500\`, installed Staging SQL regression and authenticated browser validation. **No master Phase C engineering PASS yet.**


## 8. Verified continuation after owner-applied Staging migration (2026-11-13)

**Scope:** original master Phase C comparisons, site trends and exports; not C1–C5 close-readiness. The runtime tested here is commit \`1d74ff42d50f26d3688e3d369e7071750af56458\` on PR #359. No Production deployment, merge, final profits or human accounting approval.

### Verifiable staging and CI evidence

| Gate | Evidence on this round | Verdict |
|---|---|---|
| Exact versioned migration | Supabase Staging migration ledger has \`20261113204500\` with source name \`powerhub_financial_gl_monthly_comparison_c\`; both PostgreSQL RPC signatures exist. | \`PASS_STAGING_APPLIED\` |
| RPC access control | Staging \`has_function_privilege\` explicitly reports \`anon=false\`, \`authenticated=false\`, \`service_role=true\` for both compare and trend. | \`PASS_DB_ACL\` |
| Missing service-recognition evidence | Site 1, 2026-11 vs 2026-10 returns \`BLOCKED\`, \`canExport=false\`, three blockers (\`RECOGNITION_POLICY_NOT_PROVEN\`, \`CURRENT_PERIOD_NOT_ENDED_GAZA\`, \`UNVERIFIED_SOURCE_COVERAGE\`), \`NOT_CERTIFIED\`. | \`PASS_LIVE_NEGATIVE_SCOPE\` |
| Scope/period/replay negative tests | Read-only PostgreSQL DO checked stable same-source fingerprint, cross-tenant rejection, duplicate/nonexistent site rejection, invalid month count, reversed period, and both ACLs. | \`PASS_STAGING_READONLY\` |
| Exact source reconciliation | Independent joined GL line aggregation compared 6 site-month rows over sites 1 and 9000000000099 / 2026-09..11; 0 count/revenue/direct-cost/net mismatches. This is a **limited sample**, not 1000-row reconciliation. | \`PASS_SAMPLED_6_OF_6\` |
| SQL execution sample | Staging EXPLAIN ANALYZE compare 172.408 ms, 12-month two-site trend 32.314 ms (single warm sample; not HTTP p95 or scale guarantee). | \`MEASURED_ONLY\` |
| Tests on actual C migration | Disposable PostgreSQL CI \`43508850125\` and \`43508859940\` succeeded, including C SQL ACL, policy, fingerprint and site cube proof. | \`PASS_DISPOSABLE_SQL\` |
| Runtime CI | [PowerHub CI #43508850064](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/43508850064) \`SUCCESS\` with TypeScript, Vitest, and production build; Security \`43508860012\`, Admin Guard \`43508860072\`, B5 Synthetic \`43508860218\`, PostgreSQL Integration \`43508859940\` also \`SUCCESS\` on same code SHA. | \`PASS_CI\` |
| Vercel Preview | New Preview \`dpl_69aUGe6sXQDcXryCMSE9CwH5mp9v\` is READY for runtime SHA \`1d74ff42...\`; HTTPS \`/api/health\` returned HTTP 200. | \`PASS_PREVIEW_HEALTH\` |
| Real authorized finance API | An attempt to fetch API through Vercel's protected deployment helper stopped at Vercel Authentication, before reaching PowerHub session/API. No genuine finance API acceptance was collected. | \`NOT_EXECUTED\` |
| Real browser downloads | No successful authenticated end-to-end PDF/XLSX/CSV download evidence. Unit tests use 1100 synthetic accounts, Excel workbook roundtrip, CSV safety and bounded PDF page model; actual PDF rasterization/download with browser must be checked separately. | \`OPEN_LIVE_E2E\` |
| Large throughput | No full 1100-GL-entry HTTP p95 benchmark on the current Preview and no real browser 63-page rendering budget measurement. | \`OPEN_PERFORMANCE\` |

### Updated export implementation

- Shared deterministic row constructor for CSV/XLSX/PDF; Arabic RTL report metadata includes tenant/site identity, scope, dates, fiscal currency, accounting policy, review statuses, generation time and source fingerprint.
- Numeric Excel and CSV values remain numeric; strings are escaped/CSV-formula guarded. XLSX test writes and reloads 1100 accounts, checks final row/negative numbers and unit of percentages.
- PDF now creates at most 18 GL account rows in each bounded canvas slice, with every page containing the provisional/NOT_CERTIFIED warning and fingerprint. A paginated jsPDF renderer generates page numbers; generic PDF report behavior elsewhere is unchanged.
- Export remains fail-closed on stale source fingerprint and incomplete policy. **Do not generate artificial service-recognition entries on the current financial Staging data merely to enable an export**.

### Release decision

- \`MASTER_FINANCE_PHASE_C_IMPLEMENTATION=SUBSTANTIAL_AND_TESTED\`
- \`MASTER_FINANCE_PHASE_C_DB_STAGING=PASS\`
- \`MASTER_FINANCE_PHASE_C_FINAL_ACCEPTANCE=OPEN\` pending authentic finance HTTP/session and actual PDF/Excel/CSV download plus large-volume budget.
- \`ACCOUNTING_CERTIFICATION=NOT_CERTIFIED\`
- Previously documented close-readiness C6 and live UI waivers remain \`WAIVED_BY_OWNER_NOT_EXECUTED\`, never \`PASS\`.
- PR #359 remains Draft/unmerged; Production unchanged. No broad acceptance or merge until independent approval of the remaining gates.
