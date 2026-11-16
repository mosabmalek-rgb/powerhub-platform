# PowerHub PR #359 — D43 final Staging engineering acceptance (2026-11-16)

**Decision:** `PHASE_D_PRELAUNCH_ENGINEERING_ACCEPTANCE=SCOPED_PASS`, **not** financial/documentary certification, public release approval, or exhaustive production readiness.

## 1. Exact boundary and immutable evidence

- Environment: Supabase **Staging** `iyuryuhaylhisjfcrwkz` (only test data). Production was not contacted for writes, and no new SQL migration was applied.
- Baseline commit before D43: `16868e4f7b0e0b06a8e89cfb05b15882ae773554` — five mandatory CI gates SUCCESS (PowerHub CI, PostgreSQL Integration, PowerHub Security, Supabase Admin Guard, B5 Synthetic Financial Load).
- D43 read-only audit: `docs/security/sql/pr359-financial-d43-final-staging-readonly.sql`, executed against the *installed Staging* database from the repository file with `BEGIN READ ONLY` and `ROLLBACK`. Exact returned marker: `D43_PRELAUNCH_ENGINEERING_STAGING_READONLY_SCOPED_PASS_NOT_CERTIFIED`.
- The D43 documentation/SQL commit creates a **new head**, so five green CI outcomes must be rechecked on the final head; older CI results cannot be reused as final-head proof.

## 2. Requirement-by-requirement traceability

| Requirement | Executed verification | Scoped result | Important limit |
|---|---|---|---|
| D ledger balance, tenant/site chain and fixture baseline | D43 Staging SQL, 27 GL entries / 55 lines / 361009 account movements; 0 unbalanced or foreign-scoped GL entries | PASS | Test-only balances are not certified financial statements |
| D migration identity | All 114 dated 2026-11-09 through 2026-11-16 PR migration files compared with Staging `schema_migrations`, same exact version and name; D43 asserts 13 critical phase-D versions/names | PASS | Version/name check is not a cryptographic source-file hash comparison |
| D mandatory four independent races | PostgreSQL CI: `financial_d2_two_session_approval.sh` (approve/approve), `financial_d2_close_approve_reverse.sh` (close/approve and close/reverse), `financial_d2_two_session_reversal.sh` (reverse/reverse) | PASS on baseline SHA | Separate ephemeral PostgreSQL 17 backends, not a live Staging concurrent-write run |
| D operational writes racing period close | CI: D3, D4, D8, D21 (3 source writers and close), D22 (close-first with 3 writers), plus GL exactly-once concurrent posting | PASS on baseline SHA | Fixture and integration assumptions are explicitly synthetic in CI |
| D time, service recognition and stale period boundary | `server/financial-service-recognition.test.ts`: February 28/29, Gaza DST boundary and period spread; C4 lock guard; D34 cut-off/replay; D35 and D37 temporal correction audits | PASS for implemented cases | No accounting claim from a later correction alone |
| D auth / tenant / site isolation | D36 authenticated browser-run evidence: **8/8 for tenant 1 and 8/8 for tenant 13**, three authorized 200, three foreign-scope 403, one anonymous 401 and one forged-tenant 400 in each direction on exact prior READY Preview `dpl_Hj3ned5x9pnjnbaoWGeNSPWoai4J` | PASS for owner-to-owner HTTPS | Those requests are on previous code head, not D43; non-owner HTTPS matrix remains uncovered |
| D financial role code semantics | D40 behavioral Vitest using the real site access resolver, fresh mocked service-role snapshot, plus five protected-route source contracts; tests on latest baseline SHA | PASS (CODE) | Not a device-bound non-owner HTTPS E2E |
| D UI stale-result denial, export eligibility | Existing `FinancialGLAuditPanel` and comparison component source contracts; `financial-gl-comparison.test.ts` and `financial-gl-comparison-export.test.ts` (1100 rows and blocked/stale/fake-certified export); D42 null-vs-zero financial display regression | PASS (CODE) | No new real-browser export run on D43 head |
| D finance performance | Previously reported B5 authenticated 300/300 correct and owner-attested successful p95 **under the unchanged 3000 ms limit**; B5 synthetic CI separate | PASS by owner confirmation, archival evidence incomplete | Exact successful re-run latency distribution was not available for this final report |
| D audit of Staging prelaunch opening | D35 two-entry original reversal; D37 January/November reperiodization; D43 zero cumulative 1010/3100 at January, October, November | PASS (synthetic fixture) | 0 independently reviewed opening-evidence records; never mark accounting as certified |
| D scope and reviewer separation | C4 maker/checker and staging rollback tests; D40 capability revocation and code guard; database ACL direct EXECUTE checked for 6 sensitive functions | PASS within previously executed tests | Independent documentary reviewer approval has **not** been supplied |

## 3. Fresh D43 observed Staging invariants

```text
D43_STAGING_READONLY_SQL=PASS
D_PHASE_MIGRATION_VERSION_NAME_CHECK=114/114
D43_SELECTED_D_MIGRATION_VERSION_NAME_CHECK=13/13
GL_ENTRIES=27
GL_LINES=55
GL_ENTRY_SCOPE_OR_BALANCE_ERRORS=0
ACCOUNT_TRANSACTIONS=361009
COMPANY_ACCOUNT_MOVEMENT_OPERATIONS=0
OPENING_EVIDENCE_ROWS=0
JAN_OCT_NOV_TEST_FIXTURE_1010_3100_CUMULATIVE_NET=0
DIRECT_RPC_EXECUTE_ACL=6/6_SERVICE_ROLE_ONLY
D36_GL_TRIAL_BALANCE_VOLATILITY=VOLATILE
TWO_TENANT_OWNER_SITE_ACCESS_SNAPSHOTS=4/4_SCOPED
ACCOUNTING_CERTIFICATION=NOT_CERTIFIED
```

D43 executes a named Staging-only SQL script and refuses to declare PASS when the expected tenant/site fixtures, source baseline, evidence blockers, grants, journal balances or migration names drift. SQL `powerhub_site_access_snapshot` reads do not impersonate a signed-in user.

The earlier independently executed D33 / D35 / D37 SQL scripts were rerun on 2026-11-16 and separately returned their documented `SCOPED_PASS` markers. D35 deliberately audits original 168/890 in isolation and is not used as a current balance after D37 reperiodization.

## 4. Distinct release, operational and accounting gates

A prelaunch engineering **SCOPED_PASS** is a record of the tests above, not an unconditional `D_FINAL_ACCEPTANCE=PASS`.

The following remain **outside the proven D code/SQL scope** and must be resolved explicitly before any all-up release decision:
1. **Non-owner live HTTPS role matrix** (accountant, branch-limited profile, no-report permission and active-session permission revocation). D40 is mocked-transport code testing, not a valid substitute for device-bound live user sessions.
2. **Current-final-head Vercel Preview**: the latest deployment record visible during this audit remains `dpl_Hj3ned5x9pnjnbaoWGeNSPWoai4J` on `d1e34626`. No Preview of later D40/D42/D43 code was confirmed, so no claim of HTTPS acceptance on the final head.
3. **B5 detailed successful-repeat p95 artefact**: only owner attestation to the limit is available; do not substitute earlier 3022.4ms failure or synthetic CI measurements for the successful re-run.
4. **Independent source-document certification**: no reviewed opening evidence; final P&L, cash position and balance sheet remain `NOT_CERTIFIED`.
5. **Publication/merge**: controlled PR review, preview environment verification, E/F release gates and explicit permission are prerequisites. No Production migration or PR merge in D43.

**Decision labels:**
```text
D43_ENGINEERING_STAGING_READONLY=PASS
PHASE_D_PRELAUNCH_ENGINEERING_SCOPED=PASS
PHASE_D_UNCONDITIONAL_OPERATIONAL=NOT_ACCEPTED_YET
PHASE_D_ACCOUNTING_CERTIFICATION=NOT_CERTIFIED
E_NONOWNER_AUTHENTICATED_BROWSER_MATRIX=NOT_EXECUTED
E_CURRENT_HEAD_PREVIEW_E2E=NOT_EXECUTED
PR_359=OPEN_DRAFT_UNMERGED
PRODUCTION_CHANGED=FALSE
```

This report deliberately retains the earlier historical FAIL/BLOCKED observations in the roadmap; they must be read chronologically and not treated as the current state.
