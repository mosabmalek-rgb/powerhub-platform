# PowerHub D35 — test opening temporal effect and release decision

Date: 2026-11-15. PR #359, staging `iyuryuhaylhisjfcrwkz`. Data is prelaunch test-only.

## Reproduced financial time-slice discrepancy

Opening batch 19 (`STG-FIN-A-OPENING-TEST-20261109`) is **posted** with GL entry 168 for **January 2026**: debit 1010 / credit 3100, 2,000. The batch description identifies it as a synthetic fixture, and no reviewed source evidence records exist.

Correction 890 in **November 2026** explicitly reverses entry 168, with debit 3100 / credit 1010 for 2,000. Both journals are each balanced, and the reversal is a perfect per-account inverse. However:

| Account | Signed debit-minus-credit of entries 168+890 through October | Through November |
| --- | ---: | ---: |
| Cash 1010 | +2,000 | 0 |
| Equity 3100 | -2,000 | 0 |

Therefore November's reversal fixes the **cumulative November balance** but does NOT erase the synthetic opening from **January–October period reports**. Historical as-of October finance must remain **NOT_CERTIFIED / BLOCKED**. In particular, do not mark opening 19 as independently evidenced, pretend it was absent before November, overwrite the GL, or post a second corrective movement. This project has not been launched and all records are test-only, but synthetic data cannot be treated as genuine historical evidence.

## Verified tests, scope and stop conditions

- All five required GitHub CI gates succeeded on `b7cc661ac21d4f716102740eee6b56af97aa0ff8` before adding this documentation.
- New verified final-head Vercel Preview: `dpl_HC9VcrssEfonLS6ACzPTs7rtem7h`, hostname `powerhub-platform-2eao4y7tr-mosabmalek-rgb.vercel.app`, READY. An isolated sandbox limited to this host returned /api/ready and /api/health success. Seven distinct negative authorization probes returned HTTP 401/UNAUTHORIZED, plus 40/40 negative requests at concurrency 4, no 500; sample p50 26 ms, p95 463 ms, max 923 ms. These results are **only anonymous or structurally invalid-token rejection**, not authenticated cross-tenant acceptance.
- Reran exact repository scripts D32 (rollback), D33 (read-only), and D34 (rollback) against the installed Staging DB: each returned its documented scoped-PASS marker.
- An additional read-only D35 SQL verified exact 168/890 reversal, October/November balances, zero account-movement source for site 9000000000099, absent independently reviewed evidence, and unchanged ledger counts. Result `D35_TEMPORAL_REVERSAL_OCT_BLOCKED_NOV_NET_ZERO_NOT_CERTIFIED_SCOPED_PASS`. Script `docs/security/sql/pr359-financial-d35-temporal-opening-reversal-readonly.sql`.
- D35 does not authorize replacing historical journal entries. A prelaunch fixture reset can be planned as a separate audited test-data reset with reviewed consequences for downstream fixtures; no mutation in this audit.

## Current acceptance gate

`D34_FINANCIAL_ENGINEERING_SCOPED_TESTS=PASS`; `D35_TEMPORAL_REVERSAL=SCOPED_PASS`; `D_FINAL_ACCOUNTING_CERTIFICATION=NOT_CERTIFIED`; `D_AUTHENTICATED_HTTPS_CROSS_TENANT=NOT_TESTED_ON_THIS_HEAD`; `PR_359=DRAFT_UNMERGED`.

Next prove authenticated site/tenant isolation, source-document review and the financial temporal boundary on a final SHA. Do not merge or touch Production until formally accepted.
