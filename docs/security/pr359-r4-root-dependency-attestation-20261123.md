# PR359 — live root catalog dependency digest attestation (non-authorizing)

Date: 2026-11-23. Reviewed PR HEAD: \`a8bdad79884a25ab74dfa810f9f14b0fd5e6b85c\`.

A new read-only PostgreSQL \`REPEATABLE READ\` capture on Staging
\`iyuryuhaylhisjfcrwkz\` enumerates **978 unique application roots**:
**641 functions** and **337 relations / sequences**. The \`pg_depend\`
adjacency across these root catalogs contains **6,746 incoming** and
**1,688 outgoing** dependency entries. These are direction-specific raw
catalog counts, **not** 8,434 unique cross-schema graph edges.

For each root the source stores an SHA-256 of the deterministically sorted
catalog dependency identifiers (type, schema, stable peer identity, subobject
number and \`deptype\`) and the incoming/outgoing counts. It does not
archive SQL function bodies or customer/business rows.

Files:
- \`scripts/pr359-r4/staging-root-dependency-digests.sql\` — exact read-only source query.
- \`docs/security/pr359-r4-staging-root-dependency-digests-20261123.json\` — versioned evidence.
- \`scripts/pr359-r4/verify-root-dependency-digests.mjs\` — fail-closed identity and checksum validator.
- \`scripts/pr359-r4/verify-root-dependency-digests.test.mjs\` — negative tampering tests.

**Important limitation:** 0 direct managed-peer edges are seen in this
*narrow root-object scan*. That does not contradict or supersede the
**48 independently verified managed policy/subobject → application**
dependencies from protected restore #45121222333. It also does not prove
that \`pg_depend\` includes PL/pgSQL dynamic SQL, application API calls,
Realtime subscriptions, Cron job SQL, Storage blob relationships or
offline Android Outbox usage. The existing explicit managed reverse
dependency and three Auth FK guards remain mandatory.

The archived metadata provenance and 978 current object hashes are
consistent with Staging at their capture times. **No source-controlled
canonical, clean-stack executable DDL baseline has yet been created or
accepted.** The present Staging \`schema.sql\` logical snapshot is only a
*reference comparator*, not an independently designed baseline.

\`\`\`text
R4_TWO_DISPOSABLE_STAGING_RESTORES=PASS
ROOT_DEPENDENCY_CATALOG_CAPTURE=PASS_FOR_978_OBJECTS
ROOT_INCOMING_EDGES=6746
ROOT_OUTGOING_EDGES=1688
MANAGED_SUBOBJECT_INBOUND_EDGES_SEPARATELY_ATTESTED=48
APP_OWNED_APPROVED=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
\`\`\`

Next acceptance proof: independently reviewed full executable object SQL
and source-of-truth reconciliation (not a mislabeled dump); per-object
classification and dynamic/runtime dependency audit; deterministic
clean Supabase stack rebuild twice; hardened Epoch v2; retained off-runner
encrypted backup and Storage bytes before any in-place plan.
