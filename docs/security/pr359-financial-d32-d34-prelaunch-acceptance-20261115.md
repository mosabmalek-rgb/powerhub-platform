# D32–D34: Prelaunch Staging financial acceptance evidence (2026-11-15)

**Scope:** all project data is test data, as explicitly confirmed by the project owner. This authorizes controlled Staging testing and resetting test fixtures; it does not turn failed validations into passes. Production is unchanged.

## D32 — transfer provenance behavioral tests
Test SQL: `docs/security/sql/pr359-financial-d32-operation-pair-negative-rollback.sql`.
The installed D27 RPC produced one verified pair from one correctly linked operation and two movements of 125.35; then rejected an altered amount, missing reciprocal account reference, duplicate pairing of the same movement IDs under a second operation key, and a transfer orphan. Each variant ran on the installed Staging database in an explicit transaction subsequently rolled back. D27 ACL (anon=false, authenticated=false, service_role=true) separately confirmed.

**D32 limited outcome:** `D32_STAGING_TRANSFER_PAIR_BEHAVIOR_SCOPED_PASS`. This confirms the service-side behavior for *new properly sourced transactions*. It does not make the 22,200 unlinked synthetic transfers in tenant 9000000000001 legitimate operation pairs.

## D33 — read-only financial gates
Test SQL: `docs/security/sql/pr359-financial-d33-prelaunch-acceptance-readonly.sql`.
Executed against installed Staging: `D33_STAGING_PRELAUNCH_FINANCIAL_GATES_SCOPED_PASS_BLOCKERS_PRESERVED`.

Verified: four D26–D29 migrations installed; five GitHub CI gates green on pre-change head `37d4e052acf2dcfb5559faad8bb2ff2442640e2e`; D26–D29 service-only invoker/RPC ACL; 25 structurally balanced GL entries and 51 lines; 361,009 cash-account rows; exactly 9 explicit cash/source/GL matches with zero mismatch; exact 250k technical fixture analyzed (not financially excluded); tenant 9000000000001 account openings counted once at 300,000, not twice across two sites; its 22,200 synthetic transfer movements remain blocked (11,100 net amount delta); site 1 subledger matches five checked GL balances numerically with zero differences.

## D34 — do not misrepresent the certification gate
- Opening batch 19, site 9000000000099: two lines totaling 2,000 per side but **no reviewed opening evidence**. Existing correction entry 890 in November debits equity/credits cash for 2,000; it balances, but does not itself provide document custody or independent opening attestation.
- The October service-period invoice 31 posted in November needs documented policy-based cutoff validation; no date rewriting to force close.
- D27 explicitly covers intra-site operation-key transfers; separate cross-site/interbranch settlement and GL acceptance remains a gap.
- Synthetic performance cohort is not a valid replacement for real document-level provenance; test-fixture isolation/manifest can be improved without deleting records.
- Browser HTTPS acceptance, independent multi-backend concurrency, whole-domain document-to-GL reconciliation, performance under load, and independent reviewer workflow are not established by this D33 package.
- `PHASE_D_ENGINEERING_SCOPED_REGRESSIONS=PASS`, `D34_FINAL_PHASE_ACCEPTANCE=BLOCKED`, `ACCOUNTING_CERTIFICATION=NOT_CERTIFIED`, `PR_359=OPEN_DRAFT_UNMERGED`.
- The project owner can formally decide a prelaunch *test-only* release acceptance separately from certified statements, but no such release decision is implied by the technical scope pass.

**Next actions:** resolve orphan opening 19 through an auditable test-case reversal/replacement or a complete two-person evidence and subledger chain; test service-period cutoff invoice 31 and verify no period drift; broaden tests across other financial source types and cross-site entries, and rerun D33 and the five CI checks on the resulting final SHA.