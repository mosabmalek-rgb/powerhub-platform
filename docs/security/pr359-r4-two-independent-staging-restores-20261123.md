# PR #359 — protected real-Staging isolated shadow restore: two independent PASS

**Evidence date:** 2026-11-23 (GitHub UTC finish 06:37:40, Gaza local 08:37:40).
**Review SHA (code/CI):** `3b010d3fc5ef8a812c4dcfd7b5930b963fab9b50`.
**Activation-only SHA:** `8551a71fcf7b0008e9525967e3a5e8cd065143ef`.
**Read-only hosted source:** Staging `iyuryuhaylhisjfcrwkz`, never Production.
**Protected workflow:** [45121222333](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/45121222333), attempt 1, `completed/success`.
**Protected job:** `real-staging-ledger-restore`, job `137515263890`, `completed/success`.
**Pull request:** [#359](https://github.com/mosabmalek-rgb/powerhub-platform/pull/359), still Draft and unmerged.

## Evidence observed directly in the protected GitHub Actions log

- Activation preflight, source identity, TLS/session-pooler guards: **PASS**.
- `PR359_STAGING_DISTINCT_SOURCE_SNAPSHOTS=true`; `PR359_STAGING_TWO_SOURCE_EXPORTS_CONTENT_MATCH=true`; `PR359_STAGING_TWO_INDEPENDENT_SOURCE_EXPORTS_PASS`: **two separately captured PostgreSQL MVCC snapshots and logical exports verified**.
- `PR359_STAGING_SOURCE_ATTESTED_OBJECT_ACL_REPLAY_PASS`: **twice**; effective privilege boundaries and `PR359_PRIVILEGE_BOUNDARY_PARITY_PASS`: **twice**.
- `PR359_STAGING_MANAGED_POLICY_REPLAY_LOCAL_ONLY_PASS`: **twice**; `PR359_STAGING_MANAGED_REVERSE_DEPS_EDGES=48` and `PR359_STAGING_MANAGED_REVERSE_TARGET_PARITY_PASS`: **twice**. Only seven snapshot-attested provider RLS policies were reconstructed inside disposable Docker targets.
- `PR359_R4_FULL_SEVEN_CATEGORY_SEMANTIC_PARITY=true` and `PR359_STAGING_SCHEMA_FULL_CANONICAL_PARITY_PASS`: **twice**. Every effective grantor/grantee/privilege, owner, RLS/SQL definition and the seven schema categories must match. Raw PostgreSQL system-catalog differences were limited to the reviewed dropped-column ordinal shift and ACL storage representation; these were **not** waived in the semantic check.
- `PR359_STAGING_APP_FK_CONSTRAINTS_CHECKED=561`; `PR359_STAGING_ALL_APP_FK_INTEGRITY_PASS`: **twice**; three Auth/shared FK relationships verified.
- `PR359_STAGING_TABLES_CHECKED=183`; `PR359_STAGING_FULL_APP_TABLE_COUNTS_AND_CONTENT_PASS`: **twice**. Equal-count row mutations are covered by deterministic content SHA-256 comparison, not row counts alone.
- `PR359_RESTORED_LEGACY_LEDGER_SHA256_PASS`: **twice**, preserving the Staging ledger (553 previously reviewed migration rows, reviewed whole-row SHA-256 `52b3006440effe431299a2a58b2150c18acd02ab78ffc79ffcb13075538bb613`).
- `PR359_STAGING_MANAGED_AUTH_STORAGE_ROW_PARITY_PASS`: **twice** for the four explicitly covered Auth/Storage metadata tables, not external object bytes.
- Final hard evidence: `PR359_STAGING_TWO_INDEPENDENT_EXPORT_RESTORE_PAIRS_PASS`.

### Same-head CI evidence

All six PR workflows completed `success` on **activation SHA** `8551a71...`:
- PowerHub CI: `45121229797`
- PowerHub Security: `45121229568`
- Reading Cycle PostgreSQL Integration: `45121229620`
- Supabase Admin Guard: `45121229633`
- B5 Synthetic Financial Load: `45121229725`
- Docker Shadow: `45121229599`

## Acceptance scope and explicit exclusions

**Proven:** two independent *read-only-source / isolated-disposable-target* Staging export-and-restore pairs, with schema, privilege, managed-dependency, app-row, FK and ledger parity under the reviewed checks.

**Not proven or approved by this workflow:** an empty-stack canonical **new** application baseline from version-controlled SQL; a signed exact-object `APP_OWNED` allowlist (978 candidates are unapproved); protected Migration Epoch v2 cutover; an off-runner durable/encrypted backup and independent recovery with Storage **blob bytes**; snapshot atomicity of the separate roles dump; Auth/Storage configuration/identity and offline device Outbox lifecycle through destructive rebasing; a live Staging write freeze and rollback drill; R5 end-to-end app/Android acceptance; a Production release or merge. Source controls and the runner explicitly report `STAGING_STORAGE_BLOB_BYTES_NOT_PROVEN=TRUE`, `STAGING_ROLES_CROSS_DUMP_ATOMICITY_NOT_PROVEN`, and `PR359_STAGING_EPOCH_V2_CUTOVER_PASS=NOT_GRANTED`.

**The purpose-built protected activation is reset to `requested=false` and `approved_parent_sha=UNSET` in the following evidence-closeout commit.** It is not an authorization token for future runs.

## Independent release gates

```text
R4_TWO_DISPOSABLE_STAGING_RESTORES=PASS
R4_STAGING_INPLACE=NO_GO
APP_OWNED_APPROVED=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
MIGRATION_EPOCH_V2_CUTOVER_APPROVED=FALSE
DURABLE_OFF_RUNNER_BACKUP_AND_STORAGE_BYTES_VERIFIED=FALSE
R5_FUNCTIONAL_ACCEPTANCE=NOT_GRANTED
R6_PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
```

Next non-destructive engineering milestone: reconcile the provisional 978-object register into a fully defined, SHA-bound, reviewer-approved ownership/dependency allowlist and prove that an independently assembled canonical baseline boots from a clean, compatible Supabase stack. Keep any Staging in-place SQL disabled until the additional backup, Epoch v2, remote service/Outbox and exact-change approvals are satisfied. Never use `DROP SCHEMA public CASCADE`, `db reset --linked`, or fake migration history to accelerate acceptance.
