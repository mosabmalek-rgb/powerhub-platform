# PowerHub — Phase B engineering evidence / acceptance ledger

## 2026-11-12 — B4.11 source-first correction readiness

- Verified the previous B5.6 head `5318516555f8d4e6f39af76364c6e74584227edd` passed **all 4 CI workflows**, with a SHA-matched READY Vercel Preview. PR #359 remained Draft, unmerged. Staging retained exactly 25 GL entries / 51 lines and no permanent cross-site operations or eliminations.
- Inspected posted GL and the existing `powerhub_financial_accrual_journal_reverse` + `powerhub_financial_gl_post_accrual` functions. An approved reversal must originate in the operational accrual subledger, be independently approved, and then post into GL. An unrestricted generic GL reversal would break operational/source-to-GL integrity.
- Applied and registered Staging migration `20261112133754_powerhub_financial_b411_source_backed_correction_readiness.sql`. It provides **read-only**, service-role-only, tenant/site/period-bounded `powerhub_financial_gl_correction_readiness` with 1–50 row keyset pagination. It recognizes already reversed entries, reversal entries, insufficient opening evidence, unsupported generic corrections, intact approved accrual sources that are eligible for a *source* reversal, pending source reversals, and source-vs-GL fingerprint mismatches. It **never posts GL entries** or issues financial certification.
- Guarded actual approved accrual details against original GL fingerprint and exact journal sides/amounts, as well as period/site scope. A reversal available indication is **not** financial approval; the existing maker/checker source workflow remains compulsory.
- `B411_SOURCE_FIRST_CORRECTION_READINESS_PASS_ROLLBACK` passed: original synthetic accrual GL 169 correctly reports `ALREADY_REVERSED` with linked GL 170; GL 170 reports `REVERSAL_ENTRY_IMMUTABLE`; main site keyset paging is limited; 51-row requests are rejected; 25 GL entries and 51 lines remained unchanged.
- Added protected, `viewFinancialReports`-authorized tRPC `financialGLCorrectionReadiness` with strict response validation; added read-only `FinancialGLCorrectionReadinessWorkspace` to financial audit UI. The user cannot perform generic GL posting from this view. Registered CI contracts for migration, rollback SQL, endpoint and UI.
- **Not completed by B4.11:** a generalized source-specific correction process for all invoices, payments, supplier, stock, and cash operations; two distinct authenticated users confirming corrections in the browser; year-end close / tax review. The B4 approval gate remains open, with `NOT_CERTIFIED` retained.

---


## 2026-11-12 — B5.6 reference-prefix performance evidence

- Confirmed PR #359 was Draft/unmerged with four successful CI workflows and a SHA-matched READY Vercel Preview at `1cf1359c5863191a53c7f877b1b65ea28938573e` **before** new performance commits.
- Examined actual B1/B3 call graph: `powerhub_financial_gl_site_statements` obtains `powerhub_financial_gl_source_coverage`, which calls `powerhub_financial_gl_prior_operational_gaps`; both invoke immutable performance-cohort provenance guards. Measured main-site sequential/parallel variability; source-coverage path must never be bypassed merely for latency.
- Pre-index PostgreSQL `EXPLAIN (ANALYZE,BUFFERS)` for the exact fixture reference-prefix count: **262.116 ms**, parallel sequential scan (~11,510 shared hit blocks). Applied and Git-committed generic `account_transactions_tenant_site_reference_prefix_idx` (tenant, site, reference number with `text_pattern_ops`, non-null references) as actual Staging migration `20261112132131_powerhub_financial_b56_company_account_reference_prefix_index.sql`.
- Post-index first cold plan incurred **1,623.329 ms / 2,224 shared read blocks** while loading the new index. Subsequent warm `Index Only Scan` samples: **101.339 / 66.254 / 65.576 ms**, ~2,232 shared hits and ~131 heap fetches. These are *individual query samples*, not stable browser p95 or a claim of guaranteed speedup under concurrency.
- Source-level checks after the index: fixture `verified=true`, exact 250,000 quarantined **synthetic performance records**, anchored SHA-256 unchanged, `humanReviewed=false`, `financialCertification=NOT_CERTIFIED`; prior-operational unclassified and unresolved counts **0**; 25 GL entries; position-before-eliminations assets **4,070.50**, liabilities **7,119.00**, equation difference **0**. The full fixture rows remain in the database.
- Added and executed `B56_INDEXED_STAGING_SOURCE_GUARD_PASS_ROLLBACK`: verifies actual index validity, fixture provenance, prior accounting coverage, unmodified GL counts and non-certified rollup. Added CI contract protection for migration and SQL gate. No real Production mutations or business transactions.
- Related, *not directly comparable* EXPLAIN samples of main-site source statement / prior gaps / rollup remain variable. The B5 production-like authenticated multi-user latency SLO and p95 are still **OPEN**. This is a scoped database optimization, not final B5 acceptance.

---


## 2026-11-12 — B3.9.5 orphan elimination fail-closed + UI null discipline

- Verified the previous `62851e9ac0d3e7629aea2f66659d7ef96b3dd253` PR head completed **4/4 GitHub CI**. No SHA-matched Vercel Preview was returned for that commit. This is historical CI evidence, **not** evidence for the newer commits below.
- Identified a reconciliation gap: the B3.9.4 report checked approved eliminations attached to matched transfers, but could overlook an approved elimination header whose operational source or pair of site GL entries was missing.
- Applied and registered additive Staging migration `20261112130226_powerhub_financial_b395_orphan_elimination_fail_closed.sql`. The report now counts independently detected orphan elimination headers in `orphanEliminationCount`, returns `BLOCKED_INTEGRITY`, and suppresses `approvedEliminationAmount` / approved asset and liability reductions with **NULL (not zero)** if any invalid source, orphan GL, or orphan elimination exists. It does not alter or certify the GL.
- Tested `B395_ORPHAN_APPROVED_ELIMINATION_FAIL_CLOSED_PASS_ROLLBACK`: a synthetically inserted `approved` elimination without genuine source or matching GL must return orphan count 1, `BLOCKED_INTEGRITY`, null approved amounts, `NOT_CERTIFIED` and unchanged branch GL. The test passed inside `ROLLBACK`.
- Re-ran `B311_INDEPENDENT_ELIMINATION_APPROVAL_PASS_ROLLBACK`, `B394_APPROVED_ELIMINATION_VISIBILITY_INVALID` and `B5_STAGING_ENGINEERING_GATE_PASS_NOT_CERTIFIED`: passed after the migration.
- Hardened UI: null/withheld accounting amounts render **غير متاح**, never zero. The transfer-review and elimination-approval workspace stops actions when the independent proof shows `BLOCKED_INTEGRITY` or orphan elimination records. The audit panel displays orphan count, approved elimination amount, and an expressly non-certified after-elimination preview only when the proof is valid. Added CI assertions.
- Verified durable Staging baseline remained **25 GL entries / 51 GL lines; zero inter-site transfer operations or elimination records**. No Production changes and PR remains Draft.
- **Open:** complete 4/4 CI on the final commit, SHA-matched Preview authenticated-browser maker/checker acceptance (B2 and B3), stable B5 concurrent latency SLO and any outstanding B4 generalized reversal review. Do not mark the overall phase finally certified or merged.

---


## 2026-11-12 — B3.10/B3.11 source, dual-site GL and independent elimination journal

- Implemented and applied Staging **B3.10** source creation RPC, both-site checks, exclusive account mapping, source-funds check, lock-aware operation key and equal paired account movements. Discovered cross-site audit trigger would reject a different-site counterpart under `toTransactionId`. Fixed safely in **B3.10.1** by preserving the counterpart ID as `counterpartTransactionId`; did **not** relax the original site-isolation trigger.
- Full `B310_REAL_SOURCE_TO_GL_AND_AUDIT_PASS_ROLLBACK` passed for **12.3 ILS**; maker **4**, separate GL reviewer **260**, idempotent source creation, idempotent dual-site GL replay, B3.9 independently matched pair. **No synthetic transactions persisted**.
- Added protected tRPC `financialGLCreateInterSiteTransfer` and UI `FinancialInterSiteTransferWorkspace`, with separately authenticated review procedure `financialGLPostInterSiteTransfer`. Branch/site permission checks remain on server and SQL, UI confirmation cannot bypass them.
- Implemented and applied **B3.11** dedicated `financial_gl_inter_site_eliminations` records with unique source/operation/gl links, immutable original evidence, preparer and independent approver, source revalidation on approval, and status `draft/approved`. Does **not** write elimination lines into any site GL.
- Applied **B3.11.1**, dedicated immutable, two-line elimination journal: `Dr 2350 / Cr 1350` at equal amounts, audit rows for prepare and approve, fail-closed line verification. An ambiguous PL/pgSQL `elimination_id` argument was fixed and applied as **B3.11.2**.
- `B311_INDEPENDENT_ELIMINATION_APPROVAL_PASS_ROLLBACK` passed: valid synthetic source, two site GL entries, preparation, self-approval rejected, independent approval by actor 260, idempotent re-approval, with `NOT_CERTIFIED`.
- **B3.9.4** audit/rollup reports bounded `matchedSources` with referenced elimination status and verified `approvedEliminationAmount`, still flags `NOT_CERTIFIED` and never claims consolidated statements. `B394_APPROVED_ELIMINATION_VISIBILITY_INVALID` assertion passed after approval on rollback.
- Added `financialGLPrepareInterSiteElimination` and `financialGLApproveInterSiteElimination` authenticated server mutations, both with site/capability checks and original maker/checker separation. The finance workspace now shows matched transfer sources and distinct draft vs independent approval controls, using the tenant's verified B3 rollup.
- Persistent Staging baseline after all rollback tests: 25 GL entries / 51 GL lines; 0 persisted company transfer operations; 0 persisted elimination headers / lines. No Production writes and no PR merge.
- **Open gates:** browser authentication with two genuinely distinct sessions, B2 distribution policy maker/checker browser exercise, representative B5 latency/p95 under concurrency and full balance/settlement certification; tax and financial close policies. This B3 path can receive independently reviewed elimination journals but is **not** a final certified consolidated P&L/balance sheet. New SHA-matched 4/4 CI and Vercel Preview remain to be re-verified.

---


## 2026-11-12 — B3.8/B3.9 operational cross-site GL and verified audit

- The preceding B3.7 experiment proved the accounting signs only. This follow-up **implemented** a service-role-only SQL RPC `powerhub_financial_gl_post_inter_site_source` that posts **two balanced site-scoped GL entries atomically** from a separately persisted and validated operational transfer pair. The actual applied Staging migrations are `20261112115946` and the `20261112120316` qualified-extensions digest fix.
- **Source integrity:** original and counterpart movements, active site-locked company account mapping, matching amounts/description/period/tenant/account links, actual transfer-operation MD5 payload at decimal scales 0–6, different maker and checker, checker authorized at both sites, period locks, deterministic advisory locking, exact journal fingerprint, replay checks and correction-on-conflict denial. GL uses 1350 debit / source cash credit and destination cash debit / 2350 credit; no income or expense generated.
- Added `financialGLPostInterSiteTransfer` protected tRPC mutation with `confirmSourceReview=true`, **both sites independently authorized** using `manageExpenses` and `viewFinancialReports`, actual checker identity from authenticated context, and source/paired branch checks. This does **not** create the underlying cross-site operational transfer or auto-approve it. No unvalidated two-site financial mutation is exposed to a client.
- Positive rollback E2E `B38_POSITIVE_AND_REPLAY_PASS_ROLLBACK` passed: 20 ILS, exactly two balanced GL journals, idempotent retry without new entries, maker self-review rejected, NOT_CERTIFIED retained. Negative `B38_NEGATIVE_SOURCE_SCOPE_AND_REPLAY_PASS_ROLLBACK` passed, proving forged payload and wrong site-account mapping rejected. All synthetic data (including temporary mapping) was reverted.
- Added read-only, service-only `powerhub_financial_gl_inter_site_posting_audit` with applied migrations `20261112120914`, `20261112121003`, `20261112121237`. It independently validates each source/GL pair, detects pending/invalid/orphan journals and returns only **mathematical elimination preview**, never a posted elimination or certified consolidation.
- Positive `B39_INTER_SITE_POSTING_AUDIT_PASS_ROLLBACK` checked a correct two-site 20 ILS source and dual GL journal. Found and fixed a potential false warning: valid same-site transfers must not be counted as inter-site sources. Existing B3.4 real same-site RPC test now asserts this and passed. Existing B5 Staging engineering gate also passed after the new SQL.
- The authenticated B3 rollup now invokes the audit **after checking access to every active site**, fails closed if the evidence result is unavailable or malformed, and returns `interSiteGLProof`. The UI shows matched/pending/invalid pairs and equal due-from/due-to elimination *previews* while retaining `PRELIMINARY_MULTI_SITE_ROLLUP` and `NOT_CERTIFIED`. CI contract assertions added.
- **Acceptance boundary:** source creation for a genuine cross-site account transfer is not yet exposed as a complete authenticated operation; an approved standalone *consolidation elimination journal* is not implemented; independent B2 authenticated maker/checker browser flow and B5 sustained concurrency are not yet proven. Do not mark complete B3 financial consolidation or deploy Production. PR #359 remains Draft and unmerged.
- Newly committed code/SQL requires 4/4 GitHub CI on the **new final SHA**; old successful workflow conclusions do not apply.

---


## 2026-11-12 — B3.7 positive cross-site due-from/due-to accounting proof

- Ran a **positive synthetic double-entry experiment** inside `BEGIN/ROLLBACK`, with a properly fingerprinted cross-site transfer of **20 ILS** from the primary site's cash account to the isolated second site's wallet account. No persistent account mapping, transfer, account or GL records were created.
- The experiment temporarily added chart accounts **1350** (due from another site, asset) and **2350** (due to another site, liability), then added two GL journal entries: **site 1: Dr 1350 / Cr 1010 20**, **site 2: Dr 1020 / Cr 2350 20**. Each journal was balanced.
- The preliminary multi-site rollup showed exactly **+20 net assets and +20 liabilities**, reflecting the inter-site claim and obligation. Mathematically eliminating **Dr 2350 / Cr 1350 20** returned those consolidated figures to the prior baseline, while retaining `NOT_CERTIFIED`, `isConsolidatedFinancialStatements=false` and the explicit elimination-proof warning.
- Verified no change to the 25 GL entries / 51 lines after `ROLLBACK`. Saved executable SQL at `docs/security/sql/pr359-financial-b37-cross-site-elimination-math-rollback.sql` and CI contract assertions.
- **Engineering interpretation:** this validates the double-entry signs and elimination arithmetic, **not** a production-capable cross-site transfer RPC, independently reviewed consolidation journal, legal/accounting approval, account-chart deployment or authenticated browser UI. Those are still required for full B3 closure.

---


## 2026-11-12 — B3.6 cross-site posting guard regression

- Exercised a valid, correctly fingerprinted two-site test transfer source in `BEGIN/ROLLBACK`.
- Called the actual `powerhub_financial_gl_source_plan(1,1,'account_movement',source_id)` with the cross-site source; PostgreSQL correctly refused to plan it as an **intra-site** transfer with `GL_COMPANY_TRANSFER_PAIR_INVALID_OR_CROSS_SITE`.
- Verified no additional GL entry was posted and the B3 rollup remained `PRELIMINARY_MULTI_SITE_ROLLUP`, `NOT_CERTIFIED`.
- Added regression `docs/security/sql/pr359-financial-b36-cross-site-same-site-post-denied-rollback.sql` and CI contract assertions. This protects against an incorrect double counting / unbalanced journal shortcut.
- **Important limitation:** the correct dedicated dual-site due-from/due-to posting and independent consolidation elimination workflow is **not yet implemented**; this result proves only safe rejection of the wrong posting path. Do not mark B3 final.

---


## 2026-11-12 — B5.5 post-correction read consistency and performance sampling

- Re-executed the durable B5 Staging engineering SQL gate after B4.10: `B5_STAGING_ENGINEERING_GATE_PASS_NOT_CERTIFIED`. Ran B4.6 no-fabricated-opening-evidence, B4.8 only-one-reversal, B3 preliminary rollup, B2 independent-actor SQL, B3.3 cross-site source, B3.5 forged source, and B5.2 repeat-read regression successfully. The B4.6 and B4.8 fixtures were updated for the durable 25-entry / 51-line baseline; **no active GL was mutated during these rollback tests**.
- Four different concurrent `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` PostgreSQL calls observed: B3 rollup **5,598.898 ms**; main site B4 subledger **2,091.181 ms**; main site B4 account audit **552.100 ms**; second site B4 subledger **79.811 ms**. Every corresponding root plan reported **0 PostgreSQL temporary-written blocks**.
- Three subsequent sequential B3 rollup measurements: **1,045.711 / 385.686 / 415.497 ms**, also 0 temp-written blocks. These mixed concurrent and sequential samples indicate highly variable cold/concurrency behavior, rather than a reproducible stable p95.
- B5.2 repeat-read consistency gate passed on the new durable Staging baseline; GL remained 25/51 and accounting certification remained `NOT_CERTIFIED`.
- **Not demonstrated:** long-run p95/p99 SLO, browser route latency under production-like concurrency, two independent logged-in-user review flows, or a SHA-matched fresh Vercel Preview. Do not infer full B5 performance acceptance from these database samples.

---


## 2026-11-12 — B4.10 durable Staging-only synthetic opening correction

- User reconfirmed there is no launch or real user transaction history; **Staging financial records are entirely synthetic** and may be changed for acceptance tests. No Production write, release, or merge was authorized.
- The isolated synthetic second-site opening batch **19**, source GL entry **168**, had unverified cash 2,000 ILS and capital 2,000 ILS. A verified, scoped **append-only** inverse journal was committed to Staging using the guarded script `docs/security/sql/pr359-financial-b410-staging-only-technical-opening-correction.sql`. The original opening and its history remain unchanged.
- The correction checked the exact site name, batch reference, source SHA-256, original entry/line amounts and posting, and absence of an existing reversal. It inserted debit **3100 = 2,000** / credit **1010 = 2,000**, linked `reverses_entry_id=168`, with a deterministic operation key/fingerprint and exactly one **system-attributed technical** audit event. The event explicitly sets `humanApproved=false`, `accountingCertification=NOT_CERTIFIED`, and `productionAllowed=false`. A technical `posted_by_user_id` is NOT a human-review approval.
- Verified both the rollback dry-run and the actual **COMMIT on Staging**. Result `B4_10_STAGING_TECHNICAL_REVERSAL_VERIFIED_NOT_CERTIFIED`. Persistent GL now **25 entries / 51 lines**, one matching reversal and one technical audit row; **0 fabricated opening evidence**. Site-2 cash difference and all 5 supported B4 subledger differences are **zero**; B4 document/cash audits now report matching without certification.
- Updated B5 engineering gate to demand a valid reversal, its explicit audit and zero subledger mismatch **without permitting** fabricated evidence or final-accounting approval. Re-executed the revised gate on durable Staging: `B5_STAGING_ENGINEERING_GATE_PASS_NOT_CERTIFIED`.
- Updated B4.8 duplicate-reversal negative test (second reversal correctly rejected), B4.6 prohibited-evidence negative test, and B3 preliminary rolled-up figures after this synthetic correction: 25 entries, net assets **4,070.50**, liabilities **7,119**, equity **0**, accumulated result **-3,048.50**, equation difference zero. B3 remains `PRELIMINARY_MULTI_SITE_ROLLUP` with `NOT_CERTIFIED`.
- All tests were executed inside rollback except the one explicitly authorized **technical Staging correction**. The helper SQL stored in GitHub deliberately ends in `ROLLBACK` to prevent accidental reapplication; an audited, explicit `COMMIT` was used only in this synthetic correction operation.
- **Still open:** historic original opening has no independently attested documents (although its numeric effect is now reversed); no genuine independent 2-user browser proof for B2; no standalone cross-site due-to/due-from journal and elimination acceptance; no sustained authenticated multi-user performance SLA evidence. These open gates must not be represented as certified.
- Required post-change check: four CI workflows on the new final PR SHA and SHA-matched READY Preview.

---


## 2026-11-12 — B3.5 verifiable transfer-source provenance

- Independently verified current PR head before changes: `2d4697199ce825982ea631a649bab480f9cb5a05` with 4/4 successful GitHub workflows and a matching READY Vercel Preview.
- Discovered the B3 transfer source-pair check did not validate source operation MD5 payload, creator identity, transaction descriptions, mapped account site eligibility, site status, or movement-period consistency. A synthetically paired transfer with arbitrary MD5 could pass the pair-integrity flag even though it remained uncertified.
- Applied and registered additive Staging migration `20261112111111_powerhub_financial_b35_transfer_source_provenance_hardening`. The new B3 checker compares actual RPC-aligned MD5 payload across permissible input decimal scales (0–6), both actor IDs, account-site maps and movement dates; it fails closed into `INVALID_OPERATIONAL_PAIR_BLOCKS_ELIMINATION`. It **never creates GL entries, never certifies consolidation and never accepts fabricated human review**.
- Ran four SQL test scenarios against the applied Staging function, all passing in `BEGIN/ROLLBACK`: `B3_3_POSITIVE_CROSS_SITE_SOURCE_BLOCKED_PASS_ROLLBACK`, `B3_4_REAL_RPC_TRANSFER_TYPES_PASS_ROLLBACK`, `B3_3_INVALID_TRANSFER_PAIR_PASS_ROLLBACK`, and new `B3_5_FORGED_TRANSFER_SOURCE_BLOCKED_PASS_ROLLBACK`. The positive synthetic fixture now has a valid source hash; a forged hash is explicitly detected.
- Committed migration, positive/negative regressions and CI contract assertions to the existing Draft PR #359. **New commit CI and SHA-matched Preview must be verified separately.**
- Open gates unchanged: real independently authorized inter-site due-to/due-from elimination posting and review, authorized append-only correction of unsupported 2,000 ILS site-2 opening, B2 two-login authenticated browser flow and representative sustained performance tests. Accounting certification remains `NOT_CERTIFIED`. No Production changes, PR unmerged.

---


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

## 2026-11-12 — B4.9 posted company-account transfers: source-backed GL and UI

- Prior verified head `cb74c4be5fd70a02b17c8359b5c320579b080323` passed the four CI gates and had matching READY Preview. These old results do **not** establish success on the new branch head.
- Implemented `account_movement` in the existing `powerhub_financial_gl_source_plan` and `powerhub_financial_gl_post_source` pathway for **intra-site** company-account transfers. It uses the actual `transfer_out/in` source pair; two linked account movements; exact tenant, site, account, amount, operation, source fingerprint; existing locking, privileges, balanced lines, immutable GL and idempotent replay. Transfers from cash to wallet debit `1020` and credit `1010` with **no additional revenue or expense**. Cross-site transfers are intentionally rejected pending their own elimination model.
- B4 reconciliation now counts a transfer as matched **only after** finding one correctly fingerprinted `account_movement` GL entry with two exact opposing lines and an independently matching source pair. Without GL, it continues reporting `BLOCKED_UNPOSTED_ACCOUNT_TRANSFER`. No false certification.
- Executed real-source E2E SQL: `B49_TRANSFER_GL_RECONCILIATION_PASS_ROLLBACK`: 17.30 ILS transfer, first GL post, idempotent retry with same entry, both source balances numerically reconciled, zero unposted transfer count, and `NOT_CERTIFIED`. Tested forged operation rejection: `B49_FORGED_TRANSFER_BLOCKED_PASS_ROLLBACK`.
- Found and fixed a decimal-scale mismatch: the old transfer RPC hash uses the input textual decimal precision (`12.3`) while the persisted movement uses `numeric(14,2)` (`12.30`). The validator now accepts only hashes computed from the same numeric value at representable input scales 0–6 while preserving the original actor, accounts, description and operation key. Tested `12.3` using real source RPC.
- Added a **user-initiated GL posting workspace** to the financial audit, with a server-authenticated, tenant/site-scoped and paginated candidate RPC `powerhub_financial_gl_cash_transfer_candidates`, explicit checkbox confirmation before posting, no stale financial actions on failed fetch, and no claimed success before the server acknowledges GL. The UI is keyed by site+period and invalidates B4 reconciliation after posting. Candidate test: `B49_CANDIDATES_PENDING_POSTED_PASS_ROLLBACK`.
- Staging applied migrations **20261112101831**, **20261112102257**, **20261112102934** and their exact files were committed to PR #359. CI contract tests added. No Production write or merged PR.
- **Open for Phase B full accounting closure:** independently supported and tested inter-site due-to/due-from and consolidation elimination journals, controlled disposition of the second synthetic site's unsupported 2,000 ILS opening, repeatable concurrent performance thresholds. User-reported browser checking predates the new B4.9 UI and does not prove this UI was visually tested.
- **Financial certification remains NOT_CERTIFIED**, despite successful engineering acceptance of the tested source/GL path.

---

## 2026-11-12 — B4.9.3 and B5.4 engineering closure evidence

- B4.9 GL transfer posting and B4 subledger matching are now callable from the financial audit's user-initiated, site/period-keyed UI. The server enforces tenant/site membership, `manageExpenses` and `viewFinancialReports`, limits candidate results to 25 per cursor page, verifies source ID and GL posting server-side, and never claims success without a returned GL entry ID. The table is NOT a certification workflow.
- The original transfer RPC computes an MD5 payload hash from the input decimal *scale*, while persisted account movements use `numeric(14,2)`. B4.9.2 checks hashes of the **identical amount value** at permissible textual scales 0–6 while preserving tenant, source/destination IDs, actor and description. Test `B49_CANDIDATES_PENDING_POSTED_PASS_ROLLBACK` confirms **12.3** source value posted and reconciled despite 12.30 storage. The forged transfer test remains rejected.
- B4.9.3 corrected a narrower-than-product account type guard: `cash`, `jawwal_pay`, `palpay`, `bank_of_palestine`, `other` are supported per account constraint. Source cash maps to 1010; all other near-cash accounts map to 1020, with the original source, amount and provenance validated. Test `B49_JAWWAL_PAY_TRANSFER_MATCHED_PASS_ROLLBACK` passed using the real transfer RPC with synthetic Jawwal Pay account. Staging migration `20261112103607` applied and committed to Git.
- B5.4 found a further large query bottleneck: `powerhub_financial_gl_company_movement_audit` repeatedly counted all 250,000 historical benchmark transactions. It now uses the fixed, signed/immutable Staging cohort proof only after the complete May 2026 fixture window; it counts all rows normally if proof/cutoff conditions fail. Before/after MD5 of full B4 cash audit result **identical**. Migration `20261112104342` applied and committed.
- Explicit fail-closed negative `B54_AUDIT_FIXTURE_FAIL_CLOSED_PASS_ROLLBACK`: disabling the immutable freeze trigger within rollback caused the report to count the cohort as unverified, return `BLOCKED_ACCOUNT_MOVEMENT_AUDIT`, and exclude **zero** rows; normal status returned only when the freeze guard was restored. No trigger permanently disabled.
- An earlier mixed concurrent-read sample saw ~8,385.53 ms for the B4 cash audit (before B5.4). The subsequent mixed sample after B5.4 returned B4 cash audit **442.084 / 526.056 / 416.157 ms**, B3 rollup 1,093.258 ms, B4 site reconciliation 348.828 ms, prior raw gaps 229.027 ms. No PostgreSQL temporary disk blocks were generated. These are **samples**, not proven authenticated browser p95 or SLA under sustained multi-user load.
- Both B4.9 and B5.4 regression scripts, source-key validations and CI static contracts are committed. All synthetic test transfers and account rows were rolled back. PR #359 remains Draft, Production untouched.
- **Open full financial B scope**: independently posted and audited cross-site due-from/due-to elimination journal workflow (B3), authorized append-only reversal/disposition of site 2's unsupported 2,000 ILS test opening (B4), and representative sustained performance acceptance (B5). Existing statement label `NOT_CERTIFIED` remains correct. Earlier user browser verification predates the B4.9 UI and is not evidence of its current click-path review.

---

## Historical baseline before B4.10 (superseded numbers)

The following figures and B4 site-2 BLOCKED status describe the **pre-correction test baseline**, not the present durable Staging state. Current numbers are 25 GL entries, 51 lines, 0 supported subledger balance differences; original opening evidence remains unauthenticated and certification remains NOT_CERTIFIED.


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
3. **B4:** the original unsubstantiated 2,000 opening was technically reversed in Staging with independently checked numeric and audit integrity; the original source evidence is still missing. No human approval, original statement, or final certification is implied. A generalized controlled reversal workflow is still required before launch.
4. **B5:** matching Vercel preview and E2E tests, multi-user isolation, repeated load tests / concurrency under thresholds, and all four CI gates **on final SHA**. A successful old SHA is not evidence for a new head.
5. **Production:** no migration, no SMS, no live financial posting, no merge without express approval.

## Release decision

**Engineering tests:** positive for the explicitly checked synthetic-Staging baseline.  
**Financial acceptance:** **NOT_CERTIFIED / BLOCKED where evidence is missing**.  
**Full Phase B:** **NOT COMPLETE** until the open requirements above are accepted and documented.

Keep this distinction visible in all dashboards and deployment notes.
