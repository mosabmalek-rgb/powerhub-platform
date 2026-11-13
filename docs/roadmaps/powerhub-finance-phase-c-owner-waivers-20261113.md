# PowerHub — Phase C owner-approved test exclusions (13 November 2026)

PR #359 / `feat/auth-local-first-single-pr`.

## Explicit owner decision
**WAIVED_BY_OWNER / NOT_EXECUTED**, not PASS, for the following additional acceptance tests:

1. The disposable PostgreSQL 17 **two-independent-session month-end close race**, including one-winner/other-checker loser and source-revision-after-close concurrency harness introduced in commit `2925287f8ed9fa57b286079a681a16b58593595b`.
2. The newly introduced **four-state React UI test suite** (`BLOCKED`, `REVIEW_REQUIRED`, `READY_FOR_INDEPENDENT_REVIEW`, `LOCKED_NOT_CERTIFIED`) and its stale-result/authorization-error in-flight test cases.

The owner asked to bypass these specific new test suites. This commit reverts the C6-only temporary database setup, race script, CI workflow step, UI suite, C6 contract test and now-superseded C6 test plan **without rewriting history**. Existing runtime restrictions, C1–C5 tests and CI security gates remain required.

## Evidence retained, distinct from waived scopes
- Protected Staging release #43 applied C4 migration `20261113203000_powerhub_financial_c4_period_close_integrity_guard.sql` with its precise version/name. Installed function EXECUTE is reserved to `service_role`; direct `anon` and `authenticated` EXECUTE denied.
- Installed-schema C4 rollback proof returned `C4_SOURCE_LOCK_MAKER_CHECKER_REPLAY_PASS_ROLLBACK`, including sequential maker/checker and retry guards. This is **not** an independently concurrent two-backend race.
- C5 browser HTTPS authenticated acceptance on commit `d2d88d8c0d973638ffc3f0c8c9d1f6cbe2254233`: 100/100 valid requests at concurrency 4, p95 648.3ms, no errors, no financial write. It is not a performance retest for subsequent changed code.
- Staging GL stayed at 25 entries, 51 lines, total debits = total credits = 18073.50; no saved monthly approval.

## Consequences and non-waived safety
- **No claim** of two-session close/source-writer race acceptance, all four real browser states, or authorization revocation/stale-cache UI acceptance.
- The actual DB-period lock, per-period advisory mutex, maker/checker enforcement, source integrity/ACL checks, and server permissions remain in place and must not be bypassed.
- If any other live tests are later requested, they must use authorized Staging only. Do not turn a waived case into simulated PASS.
- Preserve `ACCOUNTING_CERTIFICATION=NOT_CERTIFIED`, PR #359 Draft/unmerged and Production untouched.
- `PHASE_C_ENGINEERING=PARTIALLY_VERIFIED_WITH_OWNER_WAIVERS`. Final acceptance may be explicitly scoped, but not labelled unconditional engineering completion for untested concurrency/UI behavior.
