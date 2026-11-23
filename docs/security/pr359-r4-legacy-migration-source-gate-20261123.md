# PR359 — legacy migrations: immutable historical provenance, NOT canonical SQL

**Review:** 2026-11-23; parent PR HEAD \`7b59c33b98fb5a6da03858caa51fa71c0f12217c\`.

This report is based on:
- 700 SQL files under \`supabase/migrations/\` at pinned Git tree, identified by their **exact Git blob SHA-1 and byte length**.
- 553 distinct versions returned from **read-only** Staging
  \`iyuryuhaylhisjfcrwkz\` migration ledger query
  \`supabase_migrations.schema_migrations\`. These version IDs are metadata only, not data or executable SQL.
- Versioned snapshot \`docs/security/pr359-r4-legacy-migration-provenance-20261123.json\`, enforced in Docker Shadow smoke CI by \`scripts/pr359-r4/verify-legacy-migration-provenance.mjs\`.

## Concrete discrepancies, not inferred migrations

| Comparison | Count | Meaning |
| --- | ---: | --- |
| SQL files in Git | 700 | Historical source files, not an approved canonical set |
| Distinct filename version prefixes | 694 | 6 version prefixes occur on multiple files |
| Staging ledger versions | 553 | Protected existing history; must not be rewritten |
| Staging versions matched to Git filenames | 308 | Matches numeric prefix only, **not** SQL-body equivalence |
| Staging versions without matching Git file | 245 | Missing matching filename, not proof of lost database behavior |
| Git SQL files absent from Staging version ledger | 392 | Includes legacy/older-format files and divergent histories |
| Duplicate version-prefix groups in Git | 6 | Requires disambiguation before constructing v2 history |
| Legacy non-14-digit filename prefixes | 77 | Not new-style timestamp migrations |

These results use **literal version-prefix set membership**; they do not
prove any archived file contains the same SQL that was originally applied,
and do not imply that unapplied Git files should be installed in Staging.
The 700 raw files **must not be replayed** as a shortcut to a new baseline.
The 553 ledger rows must **not** be replaced by fabricated migration entries.

## Enforcement

The new test verifies all 700 file identities and their content against
pinned Git blob checksums, the 553-version ledger snapshot, all mismatch
buckets, and negative tests for missing/edited/extra SQL or unauthorized GO.
Any legitimate source change requires an intentional reviewed manifest
refresh. It enforces historical immutability within the PR and is **not**
a clean-stack proof.

**Further blockers before Canonical Baseline approval:** per-object
source-of-truth mapping for the 978 unapproved APP_OWNED candidates;
approved executable DDL for all objects (table/sequence, functions, RLS,
triggers, indexes, constraints and privileges); matching dependency graph
with the 48 inbound managed policy/subobject edges and three Auth FKs;
clean *compatible Supabase* rebuild twice; Epoch v2 operational ledger
strategy; off-runner encrypted backups incl. Storage blob bytes; and
signed cutover/rollback procedure.

\`\`\`text
R4_TWO_DISPOSABLE_STAGING_RESTORES=PASS
R4_LEGACY_MIGRATION_SOURCE_BLOBS_VERIFIED=CI_PENDING
CANONICAL_SOURCE_COVERAGE=INCOMPLETE
CANONICAL_BASELINE_APPROVED=FALSE
MIGRATION_EPOCH_V2_APPROVED=FALSE
APP_OWNED_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
\`\`\`
