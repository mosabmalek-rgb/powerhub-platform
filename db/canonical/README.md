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
