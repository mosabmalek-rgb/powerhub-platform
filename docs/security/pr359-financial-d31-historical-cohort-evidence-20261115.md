# D31 — PH-PERF historical Staging cohort evidence, not independent provenance

Date: 2026-11-15. PR #359. Staging project `iyuryuhaylhisjfcrwkz`.

## Confirmed via live read-only SQL
- Tenant 9000000000001 has **111,000** account movements, composed of three disjoint ID bands:
  - 1K: 900000000100001–900000000101000, 1,000 movements, account 9000000000101; SHA-256 `6c519e110c48d5937e1771909d3806782cc7449ebd00953150547f1f6018b45e`.
  - 10K: 900000000300001–900000000310000, 10,000 movements, account 9000000000102; SHA-256 `4a119559be8b890391a89aacc06bb7951b62f893c10be6ec43ac0dd90a841377`.
  - 100K: 900000000400001–900000000500000, 100,000 movements, account 9000000000103; SHA-256 `a5427ed9245ab9c69fbae2a0154d99a8b7ba5162bb1f8ff8881803ff5637eac7`.
- Hash scheme: SHA-256 of `string_agg(id::text || '=' || to_jsonb(original_row)::text, chr(10) ORDER BY id)` for each complete batch. `original_row` includes every `account_transactions` column.
- Original insert-time timestamp is the same for all 111,000 rows: `2026-11-05 13:32:57.404403+00`. Source-created timestamp is distinct from each row's `occurred_at` date. The first 105,544 occurred before 2026-11-01 Asia/Gaza (D30), and the remaining 5,456 fall after that cutoff.
- All reference numbers, expected row IDs, site parity, account ID, transaction types, amounts, and descriptions match a deterministic pattern; every 97th description uses the Arabic test-text variant. Zero mismatches across all three batches.
- Source-side direct links, attributed users, six FK-linked business tables, company-account movement operations, and this tenant's GL entries: zero in the checked scope.
- No records of an approved independent manifest for this tenant; the existing fixture-manifest schema applies specifically to the different `STG-PERF-20261105` cohort under tenant 1. Reusing that proof for this tenant is forbidden.
- Whole-Staging financial baseline remains 25 `financial_gl_entries`, 51 `financial_gl_lines`, 361,009 `account_transactions`.

## Evidentiary boundary and outstanding gates
This proves a fixed structural/content snapshot only; neither exact hash nor formula is an independent source-generation attestation. The workload-generating SQL/CI artifact, operator approval, deployment/run identifiers, and independently reviewed custody evidence have NOT been located or validated in this task. Therefore **none of these 111,000 rows may be excluded from raw finance, financially certified, or relabeled based solely on this audit**.

D30's 21,110 transfer entries (August–October) remain unproven as operation pairs. Even if deterministic odd/even row rules appear, they must never be paired by amount, time, or sequence without authoritative operation provenance. Full-period November transfers and independent source-to-cash-to-GL reconciliation remain open.

## Test status
`D31_STAGING_STRUCTURAL_FINGERPRINT_SCOPED_PASS_PROVENANCE_NOT_CERTIFIED` — read-only SQL executed against the installed Staging database. No schema migration, deletion, repost, artificial adjustment, or Production change.

Proof file: `docs/security/sql/pr359-financial-d31-historical-cohort-structural-proof-readonly.sql`. Rerun if source records, schema, references, or financial baseline changes; a drift/fail-closed result triggers investigation, not manual overriding.

D31 independent-generator attestation: **NOT_ACCEPTED**. D31 accounting exclusion: **NOT_AUTHORIZED**. Accounting certification: **NOT_CERTIFIED**.
