# PR359 R4 — live Staging catalog fingerprints, non-authorizing provenance

**Date:** 2026-11-23. **Reviewed code SHA:** \`3a296b6a49343fc64d909ea4b372959de8e86141\`.
**Source:** Supabase Staging \`iyuryuhaylhisjfcrwkz\`. One PostgreSQL \`REPEATABLE READ READ ONLY\` transaction, catalog metadata only. No Production/Staging DDL or DML.

**Source SQL**: \`scripts/pr359-r4/staging-live-ownership-fingerprints.sql\`.

**Snapshot**: \`docs/security/pr359-r4-staging-live-ownership-fingerprints-20261123.json\`. Snapshot captures identity, owner, extension membership, ACL SHA-256, function-definition SHA-256, SECURITY DEFINER and effective EXECUTE flags, and a catalog-structure SHA-256 for each table/relation/sequence. No SQL bodies, credentials, business rows, or Auth identities are stored in the snapshot.

**Observed:** 978 unique application candidates: 641 functions and 337 relations/sequences. All 978 metadata identities and checked historical privilege/owner/function-DDL fields matched their 2026-11-19 R0 snapshots on 2026-11-23. Each of the 337 relations has a fresh catalog-structure hash. The 978-way audit is enforced by \`verify-live-ownership-catalog.mjs\` and negative regression tests in Docker Shadow CI.

**Technical limitation:** A catalog structure digest (columns, defaults, indexes, constraints, policies, triggers, table options, sequence configuration, RLS) is *not* an executable full \`CREATE TABLE\`/baseline SQL script, and a fingerprint does not recover SQL source text. Extension objects and provider-managed inbound dependencies are outside the preliminary 978-candidate approval list. Postgres \`pg_depend\` alone is insufficient to infer runtime/dynamic SQL/Android/Realtime/Storage callers.

The archived register still has **zero signed ownership approvals**, **337 relation full executable-DDL definitions still unapproved**, and **978 unresolved candidate classifications**. The 48 provider-managed reverse dependencies and three Auth FKs remain mandatory cross-scope guards. Separate R1 durable off-runner backup, actual Storage blobs, clean-stack canonical Baseline, signed APP_OWNED allowlist, and Epoch v2 transition remain unapproved.

## Acceptance boundaries

\`\`\`text
R4_TWO_DISPOSABLE_STAGING_RESTORES=PASS
R4_LIVE_METADATA_978_IDENTITIES_VERIFIED=TRUE
R4_LIVE_CATALOG_RELATION_HASHES_CAPTURED=337
R4_FULL_EXECUTABLE_RELATION_DDL_COMPLETE=FALSE
APP_OWNED_APPROVED=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
\`\`\`

The protected Staging shadow request remains disabled (\`requested=false\`, \`approved_parent_sha=UNSET\`). Never treat this document or a successful catalog test as permission for destructive reset, in-place cutover, production release, or merge.
