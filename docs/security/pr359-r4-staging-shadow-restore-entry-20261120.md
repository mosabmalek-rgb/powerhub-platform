# PowerHub PR359 — Staging isolated restoration experiment, no remote mutation

Date: 2026-11-20. Initial source: `eadb8ed206868a500eb0cdf0ed49dbd016d5418c`.

## Why a separate workflow

The existing protected Docker Shadow job uses **Production** and contains
Finance migration rehearsal. Re-pointing that job to Staging is unsafe.
A new standalone `workflow_dispatch` job runs only when the selected ref is
`feat/auth-local-first-single-pr` and the opt-in repository variable
`PR359_ENABLE_STAGING_DOCKER_SHADOW=true`; it uses its own environment
`pr359-staging-shadow` and *only* the environment secret
`PR359_STAGING_SHADOW_SOURCE_DB_URL`.

The source guard rejects Production credentials when `SHADOW_SOURCE_KIND=staging`,
requires a Staging project-specific Postgres URI (TLS required; 5432;
Session Pooler for GitHub-hosted IPv4), and never emits source passwords.
The job uses the same temporary Supabase Local Stack and provider-managed
compatibility crosswalk as the prior successful R0-R3 Production shadow.
Only the **local** stack's superuser performs COPY for provider-managed
metadata. No SQL mutation is executed on hosted Staging/Production.

## Read-only Source History Gate

Pinned observed Staging migration history (2026-11-20):
- Count: 553
- Minimum version: `20260905170000`
- Maximum version: `20261116231000`
- Whole-row SHA-256 (six columns including statements/rollback):
  `52b3006440effe431299a2a58b2150c18acd02ab78ffc79ffcb13075538bb613`

The flow:
1. verifies host, TLS, read-only count and the pinned SHA;
2. compares provider-managed source against fresh isolated Supabase Local Stack;
3. exports logical schema/data/roles/history to ephemeral runner files;
4. reads the source SHA/count again under explicit read-only TLS and fails on drift;
5. restores inside Local Stack, compares restored history SHA, and checks
   application/managed counts;
6. destroys/recreates the Local Stack, restores a second time, and requires
   the two restored history fingerprints to match;
7. exits **before** any Production-only finance migration replay.

No dump artifact is uploaded, and the existing cleanup trap deletes local
copies. These source SELECTs and independent logical exports are not one
transactionally consistent database snapshot. A source write freeze remains
a separate prerequisite to an in-place rebaseline.

## Activation and acceptance

This is code-ready, **not automatically run**. A repository owner must
configure the protected environment with explicit review, store the
Staging-only URI in its GitHub environment secret (do not paste credentials
in chat), set the separate opt-in repository variable, and manually dispatch
the workflow from the PR head. Do not reuse the Production secret.

A successful run will prove Staging logical export/restoration and history
fidelity at the captured point. It will NOT demonstrate a canonical
application baseline built from zero, an actual Epoch v2 switchover,
a durable encrypted off-runner backup, a safe app-owned removal plan, or
permission for destructive Staging commands.

`STAGING_REAL_RESTORE=NOT_YET_EXECUTED`
`CANONICAL_EMPTY_STACK_BASELINE=NOT_ACCEPTED`
`STAGING_INPLACE_GO=false`
`PRODUCTION_INPLACE_GO=false`
`PR359_MERGE_GO=false`

## GitHub workflow registration requirement and protected opt-in

GitHub's `workflow_dispatch` event only triggers when a workflow exists on
the repository's default branch. This brand-new workflow exists solely in
PR #359, which is deliberately Draft; it cannot yet be manually dispatched
by the standard GitHub Actions button. Therefore it ALSO has a restricted
`push` trigger matching only the purpose-built file:

`docs/security/pr359-r4-staging-shadow-run-request.json`

The checked-in file has `requested=false` and an unusable approval token,
so it **cannot execute any restore**. To request a protected isolated run,
an authorized operator must edit this request to `requested=true` with a
fresh `STAGING-SHADOW-...` token, enable the opt-in repository variable,
and have a trusted reviewer approve the `pr359-staging-shadow` environment.
The workflow invokes the request validator before source authentication.
An ordinary push modifying unrelated PR files does not trigger this Staging
job. The Workflow Dispatch entry remains available only after default-branch
registration; no merge is being performed now.

These checks are separate from the long-standing Production release
protection. The test-only Staging request never grants database modification.

## Full application table row-count consistency (additional gate)

The read-only source metadata inventory contains **183 Staging application tables**
(173 in public, 10 in private, zero partitions). The new
`scripts/pr359-r4/staging-table-counts.sql` performs quote-safe catalog
enumeration and individual `COUNT(*)` queries inside one
`REPEATABLE READ, READ ONLY` snapshot. The table count collector
stores no individual user or financial rows and uses no hosted DML.

`scripts/pr359-r4/check-staging-table-counts.mjs` verifies exact names,
uniqueness, nonnegative safe integer counts, and complete coverage against
the R0 inventory. Before export, after export, and after each independent
local restore, it compares **each** table's counts, not just the payments/
invoices aggregates; a single missing or changed table fails closed.

Each invocation is a consistent row-count snapshot; cross-invocation or
cross-database equality does NOT prove unchanged row contents or globally
atomic source+restore snapshots. Additional row-level or WAL-consistent
backups remain a separate production-grade acceptance gate.

`R4_STAGING_183_TABLE_COUNT_GUARD=CODE_READY_PENDING_PROTECTED_RUN`
`R4_STAGING_INPLACE_GO=false`

## Equal-count row-content mutation guard (source and disposable restore)

An additional Staging-only `staging-table-content.sql` gate calculates deterministic
SHA-256 fingerprints over SHA-256 hashes of all rows in each of the **183**
application tables. It canonicalizes timezone, float and bytea output, sorts
row digests so row ordering is irrelevant, and emits only schema/table names,
row counts and hashes. The source is queried read-only before and after export,
and compared with **each** independent disposable restore. Differences in
row values fail even if the table counts are unchanged. `node --test`
regressions cover equal-count mutation, omitted/unknown/duplicate tables and
invalid digests. This is defense in depth, **not** snapshot atomicity.

**Remaining hard blocker:** `supabase db dump` invokes separate `pg_dump`
transactions for roles/schema/data/history. Matching before/after fingerprints
is not a proof that those independent dumps imported one MVCC snapshot; a
write that is reverted between checks is still possible. Before granting R4,
implement and verify a shared `pg_export_snapshot()`/`pg_dump --snapshot`
protocol (or a separately reviewed, operationally enforced source write-freeze)
with content integrity, and run the protected real-Staging restore. No claim
of successful source snapshot is made by these changes.

`R4_STAGING_183_TABLE_CONTENT_SHA256=CODE_READY_PENDING_PROTECTED_RUN`
`R4_CROSS_EXPORT_ATOMIC_SNAPSHOT=NOT_PROVEN`
`STAGING_INPLACE_GO=false`

## Shared-snapshot Staging-only export implementation

The protected staging-restore path now starts an exported read-only REPEATABLE READ PostgreSQL transaction with `pg_export_snapshot()`. A pinned PostgreSQL 17.6 client imports the exact ID through `pg_dump --snapshot` for application schema, application data, migration schema and migration data. SQL filters are pinned to Supabase CLI v3.2.0. The 183 table counts/content, finance counts and historical migration row fingerprints use this same snapshot. A SHA-256 file manifest is verified before both disposable restores. Production shadow remains unchanged. Role metadata is generated by the original Supabase CLI role-only step outside the snapshot and is **not** claimed as transactionally atomic. The external pre/post source checks may conservatively reject concurrent live changes. Code readiness does not prove successful real Staging restore or a Canonical Baseline.

`R4_STAGING_SHARED_PG_SNAPSHOT=CODE_READY_PENDING_PROTECTED_RUN`
`R4_STAGING_ROLES_SNAPSHOT=NOT_PROVEN`
`STAGING_INPLACE_GO=false`

## Fail-closed data-export pipeline regression

An independent Bash execution regression now simulates `pg_dump` exiting nonzero after emitting partial SQL. `dump_data()` checks the actual `pgdump | sed` pipeline status before appending `RESET ALL`, so a successful trailing printf cannot mask a failed export. The test also verifies the successful path produces the expected SQL envelope. The tests run in Docker Shadow smoke and require no hosted database.

`R4_STAGING_DATA_DUMP_PIPELINE_FAILURE_GUARD=CODE_READY_PENDING_CI`
`STAGING_INPLACE_GO=false`

## Staging Auth/Storage managed-row fidelity guard

A read-only SHA-256 content attestation now covers the four exact tables:
auth.users, auth.identities, storage.buckets and storage.objects.
The source fingerprints are generated from the same exported snapshot as the
schema, data and migration ledger dumps, then compared after export and after
each of the two separate disposable Local Stack restores. It outputs only
table identities, row counts and hashes. Missing, unexpected, duplicate or
equal-count changed contents fail closed.

Scope limitation: storage.objects holds object metadata, not the actual blob
bytes. Physical Storage bytes, Auth signing secrets, provider configuration,
and the role-only dump outside the snapshot need separate evidence.

R4_STAGING_AUTH_STORAGE_ROW_PARITY=CODE_READY_PENDING_PROTECTED_RUN
R4_STORAGE_EXTERNAL_BLOB_BYTES=NOT_PROVEN
STAGING_INPLACE_GO=false

## 2026-11-20 — seven-category schema digest parity

Live hosted Staging was queried READ-ONLY on PostgreSQL 17.6 and all seven
application-namespace catalog categories matched the R0 counts:
functions 641, relations/sequences 337, columns 2723, indexes 688,
constraints 1437, policies 129, triggers 202. The SQL produces SHA-256
digests over canonically ordered category metadata (including ACL, owner,
SECURITY DEFINER, RLS, definitions, and trigger enablement), without returning
object source definitions or business rows. The source query now shares the
same MVCC snapshot as the Staging SQL exports. Each disposable restoration
compares the seven category digests **before application data import** and
again after the restore. Any drift fails closed.

The live read-only Staging metadata verification is not an independent real
Staging Docker restoration, signed APP_OWNED list, or a new Canonical Baseline
generated from reviewed SQL. No in-place reset is authorized.

R4_STAGING_SCHEMA_SEVEN_CATEGORY_LIVE_READ_ONLY=PASS
R4_STAGING_SCHEMA_RESTORE_COMPARISON=CODE_READY_PENDING_PROTECTED_RUN
CANONICAL_BASELINE_APPROVED=false
APP_OWNED_SIGNED=false
STAGING_INPLACE_GO=false
