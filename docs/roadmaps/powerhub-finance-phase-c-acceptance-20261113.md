# PowerHub — Phase C engineering acceptance ledger

**Date:** 2026-11-13. **Scope:** PR #359, Supabase Staging only. **Decision:** OPEN, not finally accepted. `ACCOUNTING_CERTIFICATION=NOT_CERTIFIED`.

## Verified preliminary evidence

- On head `26c976a8f94aa6b383484e70b62cad0efaeddc44`, the five required CI workflows passed. The SHA-matched Preview deployment `dpl_8nRVBwujzHX2TGHyUfszoofdnCJC` was READY. Recheck both on every later code commit.
- `/api/ready` on that Preview reported application, Supabase configuration and connectivity ready over HTTPS. A genuine Staging owner session reached the C5 acceptance page after releasing the previous device lease for that fixture account. No bearer or refresh token was copied into the record.
- The read-only Staging C1 SQL returned `C1_STAGING_READ_ONLY_CLOSE_BLOCKERS_PASS_NOT_CERTIFIED`. GL baseline before and after: 25 entries, 51 lines, debit 18073.50, credit 18073.50; 0 saved period reviews, 0 supplier corrections, 0 inter-site eliminations, 0 accrual audit events. This verifies a read preflight, not a close.
- Five targeted test files passed 34 cases for the readiness contract, HTTP response proof, accrual components and device fast claim. A separate site-selection regression checks deterministic primary-site choice.
- Protected Staging versioned migration workflow [run #43](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/43490929743) was dispatched with target `staging`, source PR `359`, and exact C4 migration path. It is waiting for an authorized independent environment review; the version `20261113203000` was absent from the Staging ledger at the last query. No break-glass or direct schema application is permitted.

## C3 scope finding and correction

The E2E owner has both site 1 and a later isolated synthetic fixture site 9000000000099. Accessible sites are returned newest first. With multi-site entitlement off, the main financial dashboard hides its site selector and previously defaulted to that fixture, showing zeros while the live site-1 source report has one incomplete invoice and one unclassified stock movement. `selectFinancialSiteId` now chooses the oldest active site ID by default and honors a valid explicit selection. The new Preview must be inspected after CI to verify that the actual Arabic blocker counts come from site 1.

## Acceptance matrix

| Gate | Current result | Required remaining evidence |
| --- | --- | --- |
| C1 engineering | PARTIAL | Full negative close scenarios and rollback assertions after C4 |
| C2 engineering | PARTIAL | Live variant checks, isolation and stale-permission response |
| C3 UI acceptance | INCONCLUSIVE | New SHA Preview with site 1, four UI states and server error recovery |
| C4 Staging migration | NOT_EXECUTED | Protected reviewer approval, successful run and exact ledger version/name |
| C4 security/concurrency | NOT_EXECUTED | Installed-schema rollback marker and real concurrent/replay/source-change checks |
| C5 authenticated HTTPS | NOT_EXECUTED | 10×1, 10×4, then 100×4 on successful SHA; 8000ms timeout and p95 ≤3000ms for Phase C |

The two-account Preview check is `WAIVED_BY_OWNER / NOT_EXECUTED`; server and database isolation and separation-of-duties checks remain required. No GL posting, collections, mock approval, Production deployment or PR merge was performed. Do not infer accounting certification from a balanced preliminary snapshot or CI success.
