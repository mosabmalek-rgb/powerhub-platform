# CB-A — static code reference discovery for 11 catalog source gaps

Source review HEAD: `fbebaddc25ef340e37bf1fa53c364932d7cff3ff`. This is **not** a runtime-call certificate.

The workflow scans tracked `server/`, `client/`, `shared/` and `api/`
JavaScript/TypeScript files. It uses the six pinned Staging function
definitions and five pinned table-catalog snapshots to derive exact names.
Each hit records path, line, source Git blob SHA and a lexical context.
Tests and fixtures are separated. No source code snippets or secrets are
copied into the audit JSON.

Interpretation:
- `supabase_from_literal` / `supabase_rpc_literal` indicate a same-line
  name match, **not** an independently verified invocation.
- A missing literal match does not show a table/function is unused: it may
  be called through SQL, a trigger, a wrapper, generated code or dynamic SQL.
- Historical Supabase SQL and Drizzle are reviewed separately; **the Android
  `app-power-` repository is not covered** by this platform-only scan.
- Further AST, trigger, provider, tenant isolation and current-DDL checks
  are required before CB-B. No object is approved for destruction.

Run `node --test scripts/pr359-canonical/code-reference-index.test.mjs`
then `node scripts/pr359-canonical/code-reference-index.mjs --out /tmp/cb-a-code.json`.

CB_A_CODE_REFERENCES=CI_PENDING
APP_OWNED_APPROVED=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
