# PowerHub Canonical Baseline (under construction)

No executable canonical baseline is approved in this folder yet.

Source hierarchy:
- supabase/migrations: 700 immutable historical PostgreSQL SQL files. Never blindly replay.
- drizzle: historical MySQL SQL (AUTO_INCREMENT, backtick identifiers); incompatible with PostgreSQL.
- docs/security/pr359-r4-staging-object-register-20261120.json: 978 unreviewed catalog roots.
- scripts/pr359-canonical/source-index.mjs: name-based candidate source evidence only.

Run: node --test scripts/pr359-canonical/source-index.test.mjs
Run: node scripts/pr359-canonical/source-index.mjs --out /tmp/pr359-cb-a.json

CB-A: review exact per-object DDL, function overloads, ALTER/DROP, implicit sequences,
dynamic SQL, server/React/Android callers, SECURITY DEFINER, ACL/RLS, managed policies.
CB-B: author independent reviewed PostgreSQL application SQL in dependency order.
CB-C: prove two clean compatible Supabase local stack builds and behavior.
CB-D: prove migration Epoch v2 without rewriting the existing Staging ledger.
CB-E: backup and rollback, infrastructure review, explicit hosted approval.

CB_A=IN_PROGRESS
APP_OWNED_APPROVED=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE

## CB-B preparation: 11 forensic catalog source gaps
`scripts/pr359-canonical/cb-b-gap-review-bundle.mjs` now constructs an exact,
SHA-pinned, reproducible *review queue* from the six function live definitions,
five relation catalogs, R0 references, 978-root register and pg_depend
fingerprints. The output identifies privileges, SECURITY DEFINER, call-graph
and dependency gaps without emitting executable DDL, ownership approvals or
hosted actions. The result is attached to the disposable Docker Shadow CI
artifact as `pr359-cb-b-gap-review.json`.

Run:
`node --test scripts/pr359-canonical/cb-b-gap-review-bundle.test.mjs`
`node scripts/pr359-canonical/cb-b-gap-review-bundle.mjs --out /tmp/pr359-cb-b-gap-review.json`

The queue covers **11 of 978** outstanding object reviews; it does not
close any of them. All 978 remain subject to independent provenance,
effective privilege/tenant isolation and provider-managed dependency review.
No captured pg_get_functiondef or pg_catalog shape is promoted to baseline
SQL, and no clean local bootstraps have been demonstrated by this queue.

CB_B_REVIEW_QUEUE=CODE_GATED_NOT_APPROVED
CB_B_EXECUTABLE_SQL=NOT_AUTHORED
CLEAN_BOOTSTRAP_PASS=FALSE
