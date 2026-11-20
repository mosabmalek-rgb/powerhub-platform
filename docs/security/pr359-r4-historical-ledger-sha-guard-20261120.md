# PowerHub PR359 — historical migration ledger whole-row SHA-256 guard

Date: 2026-11-20. PR source head before patch: `575dcc1406d6a20d06cf833121dd1a977e7be73e`.

## Hosted read-only attestation

Captured a full-row SHA-256 across all six columns of the `supabase_migrations.schema_migrations` history on both hosted projects. No migration SQL text, rollback statements, Auth identities, or database credentials were emitted.

| Source | Historical rows | Min version | Max version | SHA-256 |
| --- | ---: | --- | --- | --- |
| Staging | 553 | `20260905170000` | `20261116231000` | `52b3006440effe431299a2a58b2150c18acd02ab78ffc79ffcb13075538bb613` |
| Production | 486 | `20260825144836` | `20261026102654` | `85f116159887cc7ac56a0fe992664af316a7c97f1b3118f65282c9d9ea57092c` |

**Scope:** these hashes cover ledger data as observed from a single SELECT in each project. They do not prove that a durable backup exists or that Source Staging and Production histories match (they do not). The current database ledger can legitimately change later; future preflight must recapture and compare against a pinned approved window.

## Docker full restore enforcement

Added `scripts/pr359-shadow/history-attestation.sql` to the existing protected Production shadow source and local target. The source is queried with `PGOPTIONS=default_transaction_read_only` and enforced TLS, before source credentials are unset. Each independent `restore()` recomputes the digest **after** restoring history rows and **before** applying financial migrations. The full job fails closed on any mismatch, including any changed `statements`, `rollback`, `name`, `created_by`, `idempotency_key`, or `version` when rows have not changed.

Only the digest and counts are returned. The source/target files remain in the ephemeral runner and are deleted by the existing cleanup trap; no SQL dump or secrets are uploaded.

CI adds static negative coverage for the stage order and exact SHA guard. The full execution result is only confirmed after the new SHA's Docker Shadow run completes.

## Remaining R4 work

Production ledger fidelity in a Docker shadow is not a Staging Epoch v2 cutover proof. Need a separately protected **Staging** full-restore rehearsal with 553 historical records, immutable manifests and durable encrypted off-runner backup, then exact canonical baseline and `APP_OWNED` authorization. The artificial Epoch v2 protocol test is already successful but does not confer authority on real projects.

`R4_STAGING_LEDGER_SHA_ATTESTED_READ_ONLY=true`
`R4_PRODUCTION_SHADOW_FULL_LEDGER_SHA_GUARD=CODE_READY_PENDING_CI`
`R4_STAGING_FULL_RESTORED_LEDGER_PROOF=false`
`R4_STAGING_INPLACE_GO=false`
`R6_PRODUCTION_INPLACE_GO=false`
`PR359_MERGE_GO=false`
