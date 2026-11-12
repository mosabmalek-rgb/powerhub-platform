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

## 2026-11-12 — B4.6 prohibited evidence + B2/B4 stale-state isolation

- The previously green head `e13d38b8db1a0eb2ff80b87d52057e3448efb220` had four successful CI gates and a matching READY Preview.
- Finance UI: `FinancialOpeningEvidenceWorkspace` is now keyed by site ID so selected files, document details and temporary review state cannot carry over to a different site. Both opening evidence actions and B2 policy details now fail closed while site/period query data is inactive, loading, refetching or errored. Static contract assertions guard these behaviors. A true logged-in multi-user browser exercise is still outstanding.
- **B4.6 Staging negative acceptance:** posted test opening `19` at site `9000000000099` remains marked `NOT-CERTIFIED`; the database guard correctly rejects any attempt to submit nominal "evidence" to a synthetic/unverified opening (`GL_OPENING_EVIDENCE_SOURCE_OR_SCOPE_INVALID`). The test verifies no custody, no evidence rows, no GL change, `BLOCKED_RECONCILIATION` and no independent attestation. Executed `B4_6_MARKED_OPENING_FAIL_CLOSED_PASS_ROLLBACK`, in `BEGIN/ROLLBACK`, and stored `docs/security/sql/pr359-financial-b4-marked-opening-fail-closed-rollback.sql`.
- An earlier attempt to submit synthetic paper-like evidence was **rejected by the intended PostgreSQL guard**; the proper solution was to assert that rejection, not disable the guard or manufacture approval. This is a financial integrity pass, not completed site opening reconciliation.
- Pending: repeat CI on latest SHA, confirm matching Preview; actual browser authentication and reviewer workflows; independent inter-site GL eliminations; unresolved test opening; sustained performance E2E. PR #359 remains Draft, no Production changes.

---

## 2026-11-12 — B5.2 final-gate revalidation and concurrency evidence

- Confirmed PR #359 head `fee7a544eb5375737f7f3ae39b9350b9cce99cc8` was **4/4 CI SUCCESS**, Draft, unmerged, with a SHA-matched READY Vercel Preview before the B5.2 changes.
- Re-executed four independent synthetic Staging acceptance scripts in rollback transactions: `B2_1_TWO_ACTOR_NEGATIVE_PASS_ROLLBACK`, `B3_2_FAULT_INJECTION_PASS_ROLLBACK`, `B4_6_MARKED_OPENING_FAIL_CLOSED_PASS_ROLLBACK`, and `B5_STAGING_ENGINEERING_GATE_PASS_NOT_CERTIFIED`. All passed. Real GL remained 24 entries / 49 lines, B2 policies zero, second-site evidence/custody zero, company movements 250,009.
- Ran 4 parallel database read requests for B3 rollup, B4 primary-site subledger and B4 cash audit. **All 4 returned identical MD5 digests per report**; no false `NOT_CERTIFIED` transitions. This verifies concurrent *read result consistency*, not authenticated user isolation, peak load capacity, or stable latency.
- `EXPLAIN ANALYZE` for 4 concurrent B3 calls returned **11,410.529 / 3,533.875 / 372.741 / 534.849 ms**. Three later sequential calls returned **475.487 / 347.918 / 342.698 ms**. The high cold/concurrent latency means **B5 performance cannot be closed as an established SLA**.
- Ran new rollback SQL `docs/security/sql/pr359-financial-b5-repeat-read-consistency-rollback.sql` and confirmed `B5_2_REPEAT_READ_CONSISTENCY_PASS_NOT_CERTIFIED`; corresponding CI contract test added. This gate confirms no GL mutation and deterministic repeat data with `NOT_CERTIFIED`.
- **No financial certification or real UI E2E is evidenced.** Opening #19 on site 9000000000099 is intentionally labeled unproven and cannot be attested by manufactured evidence; independent inter-site GL eliminations and authenticated two-user browser B2 review are still open. Production unchanged and PR #359 remains Draft.
- Next decisive work: browser E2E on a SHA-matching Preview, repeatable representative concurrent load with thresholds, and scope-specific inter-site accounting fixtures built as true *new test movements* with no false certification. CI success on this earlier head does not apply to subsequent commits.

---

## 2026-11-12 — User browser acceptance + B3.3 source-pair evidence

- User confirmed the browser has been checked. **Recorded as user-reported browser verification**, not a claim that we observed two independent authenticated user sessions or collected click-path screenshots.
- Prior head `53c119fac914bc7bbbf90df234247e29bd61020f` had all four GitHub CI gates SUCCESS and a matching READY Preview before the changes below.
- B3.3 adds cross-site **operational source** indicators to the existing preliminary tenant rollup: count of actual company-account transfer operations, count and total amount of those spanning sites, malformed source pair count, and an explicit evidence classification. Both the audit and UI never label zero candidates as independent GL elimination approval.
- The Staging dataset currently has **0 company-account transfer operation rows**: `NO_CROSS_SITE_SOURCE_OBSERVED_NOT_CERTIFIED`. It still has **2 intra-site warehouse transfers** with 170 ILS total, which are a separate operational category, not inter-site GL elimination evidence.
- Executed a controlled negative fixture inside `BEGIN/ROLLBACK`: created a synthetic transfer operation pointing at two unrelated receipt transactions; B3.3 detected 1 invalid source pair, set `interSiteSourcePairIntegrity=false`, and left `NOT_CERTIFIED`. Test result: `B3_3_INVALID_TRANSFER_PAIR_PASS_ROLLBACK`. No persistent transfer was created.
- Staging migration `20261112083854_powerhub_financial_gl_b3_inter_site_source_visibility.sql` applied and committed to PR #359, plus UI warning and CI contract. The full B5 engineering gate was extended for B3.3 fields and re-executed: `B5_STAGING_ENGINEERING_GATE_PASS_NOT_CERTIFIED`.
- **Acceptance boundary:** These are source visibility and negative checks, NOT evidence of a correctly eliminated positive cross-site transaction. A positive two-site source/GL elimination test and accounting treatment of the unsupported 2,000 ILS synthetic opening remain outside the certified acceptance. Do not create fictional evidence, relabel this as consolidated statements, or deploy Production.
- CI must be verified on the new SHA. PR #359 stays Draft/unmerged.

---

## 2026-11-12 — B3.3 positive cross-site source test

- Added a **valid two-sided test transfer** of 20 ILS from site 1 to site `9000000000099`, with separate company-account transactions and a cross-site wallet-site mapping, entirely in `BEGIN/ROLLBACK`. The two movements were paired to the same transfer-operation key.
- Verified `companyTransferSourceOperationCount=1`, `crossSiteOperationalTransferCount=1`, `crossSiteOperationalTransferAmount=20`, `invalidOperationalTransferPairCount=0`, and `interSiteSourceEvidenceStatus=CROSS_SITE_TRANSFER_REQUIRES_GL_ELIMINATION_PROOF`.
- Even a valid cross-site source does **not** certify independent inter-site GL elimination. `canBeCertifiedConsolidation=false`, `isConsolidatedFinancialStatements=false`, `accountingCertification=NOT_CERTIFIED`, GL count unchanged. Test result: `B3_3_POSITIVE_CROSS_SITE_SOURCE_BLOCKED_PASS_ROLLBACK`.
- Added permanent regression SQL at `docs/security/sql/pr359-financial-b3-positive-cross-site-source-rollback.sql` and Vitest contract assertions. No test source remains in Staging after rollback.
- The remaining work is accounting-grade matching of actual inter-site posting/elimination journal entries (currently not implemented as a certified B3 consolidation), and settlement of the separately blocked synthetic opening for site 2. This positive synthetic source test is **engineering proof**, not final consolidation acceptance.
- The user's browser check is acknowledged; no assumptions are made about separate reviewer credentials beyond the evidence available.

---

## 2026-11-12 — B3.4 correction based on the production transfer RPC

- All four CI gates were GREEN on the preceding head `9bdf8e1071dc29121f6ce93c5de0696be818fb14`; the associated Vercel Preview was READY. These older results **do not** certify the new head.
- Discovered a false-negative risk in B3.3: the rollup's source pair predicate expected `withdrawal` + `collection`, while the actual `powerhub_transfer_company_accounts_idempotent` RPC creates `transfer_out` + `transfer_in`. Changed the source comparator to the actual operation types, without relaxing matching of tenant, site, account, amount, and counterpart.
- Applied and registered Staging migration `20261112091332_powerhub_financial_b3_transfer_type_alignment.sql` and committed the exact SQL to PR #359. No Production changes.
- Directly called the **real transfer RPC** in a Staging `BEGIN/ROLLBACK` transaction for an intra-site 20 ILS transfer: paired movements were recognized without mismatches, `NOT_CERTIFIED` remained, and GL count was unchanged. Result: `B3_4_REAL_RPC_TRANSFER_TYPES_PASS_ROLLBACK`.
- Corrected the prior synthetic cross-site fixture to use `transfer_out/in` and confirmed `B3_3_POSITIVE_CROSS_SITE_SOURCE_BLOCKED_PASS_ROLLBACK`. The invalid-pair regression `B3_3_INVALID_TRANSFER_PAIR_PASS_ROLLBACK` also passed.
- Re-ran B5 on Staging after these corrections: `B5_STAGING_ENGINEERING_GATE_PASS_NOT_CERTIFIED`. Tests were added to the contract suite.
- **Still not final:** no approved standalone inter-site GL elimination entries; opening #19 on the isolated second site has no independently verified document and continues to block acceptance; representative load under concurrent users not proven. User confirmed browser checking, but distinct authenticated checker session is not independently evidenced.
- PR #359 remains Draft/unmerged. New SHA needs full CI and Preview checks before acceptance.

---

## 2026-11-12 — B5.3 prior-gap optimization with exact ledger invariants

- Starting head `f39afe0c7b5493b1804fcf593102c63365753c5c`: **all four CI gates successful**, Vercel Preview READY, PR Draft/unmerged.
- Discovered the unclassified prior-account-movement report scans 250,000 benchmark rows in the synthetic tenant (historical May 2026 records) despite existing exclusion bookkeeping. These rows are immutable and SHA-256 anchored; unrelated accounts/site/periods must never inherit their exemption.
- Applied Staging migration `20261112093106_powerhub_financial_b5_fast_prior_coverage_without_250k_rescan.sql`, committed exact SQL. The raw gap source now uses the existing guarded proof for **tenant=1/site=1 and a historical window containing the entire May fixture**. It counts all non-fixture movements through the existing partial index and adds the anchored 250,000 historical rows back to its *raw* figures. If the proof is not verified, it performs the original full counting path, without excluding anything.
- Compared digest of **raw gap result, filtered gap result, and B3 rollup before/after change**; all three were exactly equal. The raw gap continued showing 250,000 unclassified and tagged test movements; filtered report continued showing zero unresolved, with the quarantine clearly described. No false financial certification.
- Disabled `powerhub_financial_gl_fixture_freeze_write` **inside BEGIN/ROLLBACK**; the fast proof failed, the raw gap still counted all 250,000 as unresolved, and the filtered gap no longer excluded them. Re-enabled the trigger inside the test, verified recovery. Result `B5_3_RAW_FALLBACK_PRESERVES_UNRESOLVED_PASS_ROLLBACK`. The guard is active after rollback.
- **Performance limitation:** measured raw prior-gap query near 6,346 ms before and 4,955 ms after in two runs, but these are highly variable. Filtered prior-gap query after was 490 ms and B3 rollup 634 ms. This does not prove a stable p95 or closure of B5 concurrency performance. Do not claim a guaranteed speedup.
- Test contract added. No change to 24 GL entries/49 lines, no B2 central allocations, no manufactured site-2 opening evidence; Production unchanged.
- Outstanding full-B closure: site-2 2,000 ILS opening requires a formally authorized accounting disposition; independent GL elimination entries for cross-site transfers remain unimplemented/unproven; repeatable load benchmarks and post-change green CI on the final SHA are still required.

---

## 2026-11-12 — B4.7 cash-transfer correction, B4.8 opening reversal simulation, and operational amount display

- Browser validation is user-reported; real independent two-user browser-role coverage remains subject to scope confirmation.
- **B4.7:** The real company-account transfer RPC creates `transfer_out` and `transfer_in`. B4 previously called them unknown and did not include their signed operational cash/wallet effects. The Staging function now recognizes these as known types, computes signed source balances, and returns `BLOCKED_UNPOSTED_ACCOUNT_TRANSFER` for both cash and wallet until a supported GL journal exists. Test `B4_7_TRANSFER_RECOGNIZED_BUT_GL_BLOCKED_ROLLBACK_PASS` passed with a synthetic 17.33 ILS RPC transfer. B5 gate remained `B5_STAGING_ENGINEERING_GATE_PASS_NOT_CERTIFIED`.
- Staging recorded two generated migrations with the same B4.7 name, versions `20261112094941` and `20261112095117`. Both are represented by idempotent final-definition SQL files in Git. This duplicate sequence is explicitly tracked for future migration hygiene; do not rewrite applied migration history silently.
- **B4.8:** A posted synthetic opening cannot be voided by the draft-only void RPC. An append-only correction/reversal was simulated for original GL entry 168 (site 9000000000099, 2,000 ILS), with exact opposite lines and `reverses_entry_id=168`. This eliminated the *numeric* cash difference but did not certify source evidence. Test `B4_8_POSTED_TEST_OPENING_REVERSAL_SIMULATION_PASS` passed inside `BEGIN/ROLLBACK`. No permanent GL reversal or fabricated authorization was saved. A production-ready controlled correction workflow remains outstanding.
- **Display policy from user:** operational money amounts usually have no fraction (~99.5%); a small minority have one decimal (~0.5%). Modified B1/B3/B4 audit, B2 central costs and opening-evidence **display only** to use `minimumFractionDigits:0, maximumFractionDigits:2`: integer values show with no decimal, one-decimal values keep one, genuine 2-decimal sums remain intact. B2 allocation percentages continue using exact basis points and up to 2 decimal percentage digits. Storage, API amounts, GL postings and idempotency hashes unchanged. Contract tests enforce the UI choice.
- Invariants after rollback remained 24 GL entries / 49 lines; 0 central policies, 0 company-transfer operations, 0 second-site opening evidence and custody documents.
- **B is not financially certified:** no independently proven inter-site elimination workflow; isolated posted opening requires authorized reversal process, and concurrency/performance thresholds are not accepted. CI/Preview must be checked at the latest head. PR #359 stays Draft and Production was not touched.

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
