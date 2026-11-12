# PowerHub — Phase B engineering evidence / acceptance ledger

**Date:** 2026-11-11 (Asia/Gaza)  
**Pull request:** #359, Draft, **not merged**  
**Environment:** Staging only, all records are prelaunch synthetic test data  
**Result:** **B5_STAGING_ENGINEERING_GATE_PASS_NOT_CERTIFIED**. This is evidence of a tested engineering baseline, **not** completed Phase B financial acceptance, audited statements or permission to deploy Production.

## 2026-11-12 — B3.2 warehouse pair fault injection and B5 guard

- All four GitHub CI gates passed on the prior tested head `0d666468fee4cdb73aa616664d4880539f9d85b0`. The B3.1 database migration `20261110225954` was recorded on Staging.
- The B3.1 report now separately counts **2 intra-site warehouse transfers valued at 170 ILS** whose source/destination movements match, with **0 pair discrepancies** and **0 candidate inter-site GL entries**. This is **not** evidence that inter-site consolidation eliminations were independently reconciled.
- Executed an actual Staging synthetic fault injection in `BEGIN/ROLLBACK`: changed transfer #2 from 70.00 to 70.01, verified `intraSiteWarehouseTransferMismatchCount=1` and `warehouseTransfersPaired=false`, while `accountingCertification=NOT_CERTIFIED`; result `B3_2_FAULT_INJECTION_PASS_ROLLBACK`. No change persisted.
- Saved the reusable regression in `docs/security/sql/pr359-financial-b3-transfer-pair-fault-injection-rollback.sql`. Updated the B5 Staging engineering gate to verify the paired count, sum, zero mismatch, classification, and continued non-certification. B5 gate re-executed and returned `B5_STAGING_ENGINEERING_GATE_PASS_NOT_CERTIFIED`.
- Added Vitest contract assertions for the migration, fault test, B5 gate and UI warnings. CI must be confirmed again on the new final SHA, not inferred from the old passed SHA.
- B2 authenticated two-user browser review, missing 2,000 ILS opening documentation, standalone inter-site elimination evidence, and sustained concurrent E2E performance remain open. **Phase B is not financially certified.** PR #359 stays Draft; Production untouched.

---

## 2026-11-12 — B2.1 independent-actor SQL acceptance

- Last verified pre-change PR head was `95ff9f09e725d02d17d682cf58d42094247579cf`; all four CI checks passed on that head and its Vercel Preview was READY.
- Re-ran B2/B3/B3.2/B5 tests on synthetic Staging using `BEGIN/ROLLBACK`; they passed with results `B2_1_TWO_ACTOR_NEGATIVE_PASS_ROLLBACK`, `B3_PASS_ROLLBACK_ONLY`, `B3_2_FAULT_INJECTION_PASS_ROLLBACK`, `B5_STAGING_ENGINEERING_GATE_PASS_NOT_CERTIFIED`.
- B2.1 used **two separate existing synthetic tenant actor IDs 4 and 260** through actual PostgreSQL RPCs: unauthorized prepare/approval were denied; maker self-approval was denied; the independent test checker approved inside the transaction; draft was not prematurely reported approved; exact retry reused the policy; modified payload or changed operation key caused conflicts; the GL entry/line counts were unchanged. The transaction was rolled back, leaving no central policy or synthetic human approval.
- SQL source: `docs/security/sql/pr359-financial-b2-two-actor-negative-rollback.sql`. Static contract assertions were added in `server/financial-stage-a-acceptance.contract.test.ts`.
- **IMPORTANT acceptance boundary:** invoking SQL with distinct actor IDs is **not** the same as two authenticated users interacting in the browser with authorization scoped by `requireSupabaseSiteRole`. E2E browser verification on the matching current Preview is still required.
- No real accounting evidence or signed opening documentation exists for the 2,000 ILS synthetic second-site opening; it still must be reported as unreconciled. B3 remains preliminary and inter-site eliminations unreviewed. No merge and no Production change.
- The four CI gates must be checked again on the final SHA after this documentation update.

---

## What has been verified

| Scope | Direct evidence | Status |
|---|---|---|
| B1 — initial site statements | 24 GL entries, 49 lines; equation difference zero on both test sites; `NOT_CERTIFIED` | Implemented and structurally checked |
| B2 — administrative central expense distribution | `B2_PASS_ROLLBACK_ONLY`: 85-unit expense split 60/40 = 51/34; rejects 90% weights and self-approval; no GL posting | Backend/database acceptance passed; browser review still open |
| B3 — preliminary multi-site rollup | `B3_PASS_ROLLBACK_ONLY`: 2 sites, 24 GL entries, net assets 6,070.50, liabilities 7,119, posted equity 2,000, unclosed accumulated result -3,048.50, equation difference zero | Preliminary only; `NOT_INDEPENDENTLY_RECONCILED` internal eliminations |
| B4 — main site subledgers | 5/5 balances matched, 16 document sources, 9 linked cash/account movements, zero mismatches among supported sources | Numeric/document matching; `NOT_CERTIFIED` |
| B4 — isolated second site | GL cash 2,000 versus assistant ledger 0. No opening evidence/custody documents. | **BLOCKED**, not accepted |
| B5 — combined safety gate | `docs/security/sql/pr359-financial-b5-staging-engineering-gate.sql` executed on Staging in `BEGIN/ROLLBACK`; result `B5_STAGING_ENGINEERING_GATE_PASS_NOT_CERTIFIED` | Engineering-only automated check passed |
| B5.1 — fast integrity proof | `docs/security/sql/pr359-financial-b5-fast-proof-negative-rollback.sql`: disabled write-freeze trigger inside reversible transaction; proof correctly failed closed, then recovered | Security-negative test passed |

Previously executed isolated SQL evidence: `B2_PASS_ROLLBACK_ONLY`, `B3_PASS_ROLLBACK_ONLY`, `B4_1_PASS_ROLLBACK_ONLY`, `B4_2_PASS_ROLLBACK_ONLY`, `B4_5_INDEX_AND_LEDGER_PASS`.

## B5.1 performance remediation

**Issue:** `powerhub_financial_gl_prior_operational_gaps` repeatedly invoked the complete 250,000-row SHA-256 verification in every site-statements/rollup request. A B3 run used ~14.37 seconds and ~25,662 PostgreSQL temporary write blocks.

**Fix:** `20261110223326_powerhub_financial_b5_fast_staging_fixture_coverage.sql` adds `powerhub_financial_gl_fast_staging_fixture_proof` and uses it **only** for tenant 1/site 1/months after 2026-05. It checks a fixed SHA-256 evidence record, exact 250,000-row cardinality, active immutable write/truncate/record triggers, and operational cross-references. A guard failure makes `verified=false`; unclassified test records are **not** silently excluded. `powerhub_financial_gl_verify_staging_fixture` remains the independent full-hash verifier. This optimization makes **no data edits**, does not imply human approval and never changes `NOT_CERTIFIED`.

Selected `EXPLAIN (ANALYZE, BUFFERS)` samples in Staging, not SLA guarantees:

| Path | Before | After B5.1 / measured samples |
|---|---:|---:|
| B3 whole preliminary rollup | 14,369 ms | 2,271 ms single run; 1,013 / 370 / 324 ms in an additional concurrent-read sample |
| B1 site statements, primary branch | 14,837 ms | 408 ms |
| Prior operational gaps | 9,648 ms | 372 ms |
| B4 company movements | Earlier variable 0.64–8.36 seconds | 1,863 ms under the same concurrent-read sample |
| Full 250k-row hash (independent) | 10–15 seconds | **Still full**; intentionally not part of every rollup |

An actual browser experience and sustained concurrent-load test have **not** been verified. A matching recent Vercel preview has **not** been established for the latest branch head.

## Incomplete acceptance requirements (must not be marked done)

1. **B2:** E2E interactive prepare/approve with **two distinct authenticated user identities**. SQL regression does not prove button behavior, authenticated review or permissions in the browser.
2. **B3:** independently sourced inter-site transfer eliminations; accounting for shared central balances and preventing double count; tax mapping; verified consolidation. Current result remains preliminary even if transfer candidates count is zero.
3. **B4:** the 2,000 cash opening test entry on site `9000000000099` must have independently verifiable auxiliary evidence, or remain explicitly unresolved. Do not invent a human reviewer, uploaded statement, matching account transaction or false zero-difference entry merely to pass.
4. **B5:** matching Vercel preview and E2E tests, multi-user isolation, repeated load tests / concurrency under thresholds, and all four CI gates **on final SHA**. A successful old SHA is not evidence for a new head.
5. **Production:** no migration, no SMS, no live financial posting, no merge without express approval.

## Release decision

**Engineering tests:** positive for the explicitly checked synthetic-Staging baseline.  
**Financial acceptance:** **NOT_CERTIFIED / BLOCKED where evidence is missing**.  
**Full Phase B:** **NOT COMPLETE** until the open requirements above are accepted and documented.

Keep this distinction visible in all dashboards and deployment notes.
