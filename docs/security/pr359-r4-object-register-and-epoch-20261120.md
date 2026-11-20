# PowerHub PR359 — R4 per-object review register, not an allowlist

Date: 2026-11-20. Source SHA: `2f56f6ce0fab665c055e0f627ea84bd5d3b15d79`.

The source snapshots from 2026-11-19 have been converted to a
per-object register with **978 identity rows** (337 relations/sequences and
641 functions). Each row retains schema, object identity, owner, extension
membership, the R0 classification flag, reviewed status and available
ACL/function-definition SHA-256. Relation full-definition hashes are absent
in the historical R0 relation file, so they remain NULL rather than fabricated.

All 978 classifications remain `APP_OWNED_CANDIDATE` and
`reviewed=false`. This source is neither transactionally
atomic nor a current-SHA catalog freeze, and postgres ownership is not proof
of application ownership. No item is authorized for removal.

**Index/constraint source recovered (2026-11-20):** The GitHub contents fetch
returned the entire valid JSON for
`docs/security/pr359-r0-staging-indexes-constraints-20261119.json`.
The narrow `fetch_file` view had returned an empty string for the large file,
which was a retrieval limitation, not corruption. The historical source has
**688 indexes, 1,437 constraints and 561 FKs**. A separate read-only Staging
query confirmed those counts, **zero invalid indexes**, **zero unvalidated
constraints**, and the three exact Auth shared FKs. Metadata comparison
and negative regression tests run in Docker Shadow CI.

This resolves **source retrieval and count/identity reconciliation**, not
per-object current live DDL SHA parity or final APP_OWNED classification.

The fail-closed register tests detect duplicate identities, missing objects,
unexpected provider ownership, missing function hashes, tampered historical
classification and any attempt to populate a destructive allowlist.

## Migration Epoch v2 — proposed guard, no database changes

A safe epoch transition still requires an approved and isolated rehearsal:
immutable historical ledger export and SHA-256, a reviewed canonical baseline
from an empty compatible stack, exact SQL fingerprint and migration executor
with monotonic epoch transitions and idempotent replay. Record separate
historical lineage and v2 state; never mark historical migrations applied
without executing/verifying them, and never use a broad repair/push against
the old ledger. Rollback rehearsals must preserve Auth/Storage, offline Outbox,
financial invariants and cron controls.

**No executable epoch transition or Staging teardown is included.**
The R3 source restore evidence proves upgrade replay, not necessarily that
the canonical application database can be freshly built from a single
version-controlled empty-stack baseline.

R4_OBJECT_REGISTER_ROWS=978
R4_CLASSIFICATION_SIGNED=false
R4_INDEX_CONSTRAINT_COUNTS_MATCH=true
R4_FULL_DDL_RECONCILED=false
R4_EPOCH_V2_EXECUTED=false
R4_STAGING_INPLACE_GO=false
R6_PRODUCTION_INPLACE_GO=false
PR359_MERGE_GO=false
