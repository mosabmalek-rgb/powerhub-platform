# D37 — Staging-only fixture opening normalization, 15 November 2026

**Scope:** project `iyuryuhaylhisjfcrwkz`, tenant 1, isolated test-only site `9000000000099`. No Production changes or merge.

### Why this was needed
Original January 2026 opening GL #168 (debit cash 1010 2,000 / credit equity 3100 2,000) was offset in November by GL #890. Their combined balance remained nonzero in January–October reports. The owner explicitly confirmed all data is prelaunch/test-only and authorized Staging test-data modifications.

### Actual Staging data-only correction (transaction committed)
- January: new GL `correction` with unique key `gl:prelaunch:opening19:jan-correct:v1`; debit equity 3100 and credit cash 1010 for 2,000.
- November: new GL `correction` with unique key `gl:prelaunch:opening19:nov-restore:v1`; debit cash 1010 and credit equity 3100 for 2,000; `reverses_entry_id=890`.
- Exact fixed tenant/site and identity/baseline checks, transaction-scoped advisory lock, and cumulative January/October/November per-account zero checks passed. Previous entries #168 and #890 and original posted opening #19 were neither deleted nor updated. Database GL immutability triggers were not disabled.
- GL counts moved from **25 entries, 51 lines** to **27 entries, 55 lines**, account transactions stayed **361,009** and independently reviewed opening-evidence rows stayed **0**.
- Correction prevents misleading historical test balance for the two accounts but does **not** claim documentary certification or certify an unverified historical opening. No policy migration was required.

### Verification
- First performed the same insertion shape within a `ROLLBACK` transaction, receiving `D37_STAGING_FIXTURE_REPERIODIZATION_ROLLBACK_PASS_NO_PERSISTENT_WRITES`.
- Applied guarded Staging transaction and received `D37_STAGING_TEST_FIXTURE_NORMALIZED_NO_CERTIFICATION`.
- Reran D31/D32/D33/D34/D35 Staging SQL with the new 27/55 baseline; all five scoped-PASS results returned.
- Persisted read-only D37 audit script: `docs/security/sql/pr359-financial-d37-opening-fixture-audit-readonly.sql`.
- D35 keeps auditing the original 168/890 pair in isolation, whereas D37 audits *all correction entries* and actual cumulative period balances. Do not confuse the two reports.

### Boundaries
- D36 authenticated role/tenant/site HTTP isolation and B5/C5 authenticated benchmarks still need a real authorized, device-bound Staging account. CI simulation, anonymous 401 and SQL ACL probes do not establish this.
- `D37_TEST_FIXTURE_PERIOD_BALANCES=SCOPED_PASS`; `ACCOUNTING_CERTIFICATION=NOT_CERTIFIED`; `D_FINAL_ACCEPTANCE=IN_PROGRESS`; `PR359=DRAFT_UNMERGED`.
