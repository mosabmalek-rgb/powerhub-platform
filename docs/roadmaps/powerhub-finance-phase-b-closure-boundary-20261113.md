# PowerHub — Phase B engineering acceptance boundary (13 November 2026)

> **Evidence-led disposition:** B5 authenticated HTTPS is PASS; Phase B as a whole is **NOT YET FULLY OPERATIONALLY ACCEPTED**. Do not label outstanding E2E tests PASS, confuse SQL actor fixtures with human approvals, certify finances or merge/deploy Production.

## Immutable verification baseline
- PR #359 branch `feat/auth-local-first-single-pr`; baseline SHA `f41f11d0e2e67ceee86349c5a390371e201ccb6a`.
- Five GitHub CI workflows SUCCESS on this exact SHA.
- Vercel READY Preview `dpl_3bbLXXvFCqKvBnbgMK8sZjhp3N2F`; deployed SHA matches branch HEAD.
- B5.23 `20261113164500` registered in Staging `iyuryuhaylhisjfcrwkz`; compact index exists.
- Authenticated, single-device, real browser HTTPS acceptance: **100/100** each, concurrency **4**, 8000ms timeout, 0 errors; p95 **2131.3ms** subledger, **892.5ms** company movement, **1279.3ms** site statements; budget **≤3000ms**.
- Fresh, direct Staging SQL inspection: **25 GL entries / 51 lines**, **0** unbalanced, cross-site/cross-tenant line mismatches or missing source fingerprints, **0** supplier corrections, **0** elimination headers, **0** central allocation policies.
- Re-executed `docs/security/sql/pr359-financial-b5-staging-engineering-gate.sql` in a rollback transaction: `B5_STAGING_ENGINEERING_GATE_PASS_NOT_CERTIFIED`.
- Re-executed `docs/security/sql/pr359-financial-b416-supplier-atomic-correction-rollback.sql` after removing only the psql client metacommand `\\set ON_ERROR_STOP on`: `B416_ATOMIC_SOURCE_CORRECTION_NEGATIVE_REPLAY_PASS_ROLLBACK`. All synthetic writes rolled back.
- Original B5 proof: https://github.com/mosabmalek-rgb/powerhub-platform/pull/359#issuecomment-6859720718
- Independent engineering gate matrix: https://github.com/mosabmalek-rgb/powerhub-platform/pull/359#issuecomment-6859861749

## Scope-by-scope decision
| Gate | Evidence accepted | Explicit residual |
|---|---|---|
| B1 | Source checks and real B5 HTTPS `financialGLSiteStatements` at site 1 | Broader human-observed UI statement acceptance not proven |
| B2 | SQL maker/checker, permissions and rollback | Two-account Preview browser test **WAIVED_BY_OWNER / NOT_EXECUTED**, never PASS |
| B3 | Two-site source-backed GL, elimination and negative rollback | Same narrow two-account Preview test waiver; live entitlement UI unproven |
| B4 | Source-backed reconciliation and supplier B4.16 atomic/replay rollback; UI mocked contract tests | Authenticated correction mutation UI/tRPC E2E not established; independent refund evidence and exceptional-source correction scope not blanket certified |
| B5 | **PASS** for the three specified read-only authenticated GET reports on baseline SHA | Not a performance acceptance for other mutations, sites, months, or Production |
| Human accounting | **NOT_CERTIFIED** | Documentary opening balances, independent accountant approval and full financial close |

## Strict boundary and handoff
- **B_ENGINEERING_CORE_EVIDENCE=PASS_IN_VERIFIED_SCOPE**.
- **B_FINAL_OPERATIONAL_ACCEPTANCE=OPEN** until non-waived B1/B4 E2E/sign-off is established. Keep B2/B3 owner exception clearly labelled.
- **B5_REAL_AUTHENTICATED_HTTP=PASS** on baseline SHA, not automatically on subsequent commits.
- **ACCOUNTING_CERTIFICATION=NOT_CERTIFIED**. Financial previews cannot claim audited revenue, balance sheet, or certified net income.
- **PR_359=OPEN_DRAFT_UNMERGED**, **PRODUCTION_DEPLOYED=NO**.
- Proceed with read-only Phase C1 discovery in parallel; this is not a retroactive waiver of missing B acceptance.
- Revalidate CI on any subsequent commit and Preview SHA when runnable code changes. Do not create a new Preview solely for an evidence document or test script.

## Next acceptance work
1. Record a scoped, single-authorized-user UI walkthrough of B1 statements and B4 correction **readiness/errors** on the same-SHA Preview. Do not create a genuine payment correction without independent verified refund evidence.
2. Confirm tenant/site permission denials and non-certified status on the UI/API, including stale-cache suppression and source mismatch blockers.
3. Preserve all SQL/CI maker-checker and device constraints; never manufacture human approval or a documentary refund.
4. Obtain an explicit final Phase B product sign-off once those non-waived gates are satisfied; merge/Production is a separate decision.
