# PR #359 engineering verification — 8 November 2026

## Scope and current evidence boundary

Source baseline fetched directly from the existing HTTPS Git remote:
`83633d7c21fbd94cd6ac7e7187861589b52c1992` on
`feat/auth-local-first-single-pr`. `origin/main` is
`6356ed4c0d58506adc87d9a000855e9d913aefcf`; the baseline includes it
(`git rev-list --left-right --count origin/main...HEAD`: `0 1993`).
The working tree was clean before this work. No remote history was rewritten.

GitHub API calls were attempted using existing authentication. Both `gh pr view`
and a fresh HTTPS REST request to `api.github.com` were denied with HTTP 403
by the network proxy. At that initial inspection the PR draft/open/mergeability and
same-SHA Actions results were **UNVERIFIED**, not green based on the handoff.
The later direct GitHub HTML verification below supersedes that initial status.
The handoff's successful Actions links remain historical evidence only.
No GitHub PR state mutation, merge, workflow dispatch or deployment was requested.

No Supabase/database connector or Supabase/PG/database variable binding was
available. No Staging or Production connection was made. All database writes
below used a new disposable PostgreSQL 17 container with synthetic data and no
published database port. No live migration, history repair, ACL change, Cron,
pg_net, Vault access, SMS or real financial operation was performed.

## Fixed: release-time name race

The runner classified version/name/hash before opening its release transaction.
Inside the shared advisory lock it rechecked only `version`. Two callers with
an empty preflight snapshot could release different versions of the same name,
creating the duplicate-name history the preflight explicitly rejects.

`buildSupabaseMigrationTransaction` now owns the exact transaction used by the
runner. It validates identifiers through the existing ledger-insert builder,
explicitly selects READ COMMITTED (including when the session default is REPEATABLE READ),
acquires the existing transaction-scoped advisory lock, and rejects **both**
existing versions and names before executing SQL. A concurrent identical release
fails closed; a later invocation can take the normal exact-content no-op path.
No live schema constraint or historical migration was changed.

The new integration test executes this production builder against real PG17:

- Stored exact payload/hash gives `already-applied`; empty history gives
  `not-applied`.
- Changed content, NULL/empty SQL arrays, same-name/different-version,
  same-version/different-name and duplicate names fail closed.
- Concurrent same-name/different-version transactions have exactly one winner.
- Concurrent same-version/different-name transactions have exactly one winner.
- Migration SQL failure rolls back both effects and history.
- A synthetic ledger INSERT failure after successful migration SQL also rolls
  back effects and history.

The new concurrency test was first executed with the old version-only guard:
**FAIL**, two winners (`2 !== 1`). With the fixed builder: **PASS**, one winner.
The workflow now runs `scripts/test-supabase-migration-release-guard.mjs` in its
own `supabase_migration_release_guard_test` database. The test refuses any host
other than loopback and any other database name. Production target validation
was not relaxed to permit local tests.

## Seven security migrations: source and isolated execution map

All seven SQL files were reviewed at the baseline and left byte-for-byte intact.
Five existing fixtures cover them (the prior report's reference to six fixtures
was a counting error):

| Version | Source boundary | Exact executed fixture |
|---|---|---|
| `20261107120000` | Restrictive site SELECT policies over historical tenant policies; child allocation scope | `inventory_supplier_site_rls_scope.sql` |
| `20261107130000` | Phase D invoker RPC; server-only EXECUTE; reject malformed branch/supplier allocation | `inventory_purchase_receiving_workflow.sql` |
| `20261107130443` | Active admin identity, allowlisted platform role, explicit capability; postgres-owned DEFINER, empty path | `platform_support_identity_role_guard.sql` |
| `20261107140000` | Payables invoker RPC; server-only EXECUTE; reject both incoming/outgoing cross-site allocations | `inventory_purchase_receiving_workflow.sql` |
| `20261107143819` | Preserve company helper owner and ACL while pinning empty path | `financial_site_rls_scope.sql` |
| `20261107150000` | Revoke table and column SELECT browser grants on ten tables; preserve service SELECT | `inventory_supplier_site_rls_scope.sql` |
| `20261107150951` | Future postgres defaults only; global PUBLIC function revoke; provider-owner preservation | `default_privileges_acl_guard.sql` |

All five fixtures were actually executed with `ON_ERROR_STOP=1`: **PASS**.
The changed supplier/support fixtures were executed again: **PASS**.
The fixtures are referenced by `reading-cycle-sql-integration.yml`.

The supplier fixture retains its existing legacy column-SELECT grant regression.
Added coverage executes actual SELECTs on all ten supplier tables as anon and
as an authenticated tenant owner, expecting `insufficient_privilege`, then
executes SELECTs as service_role and requires nonempty synthetic results.
It replays the final ACL migration first. This verifies SQL privilege behavior,
not a hosted PostgREST HTTP configuration.

The support fixture now reapplies the identity migration and checks both missing
JWT identity and revocation of a previously authorized account. Existing tests
already exercise non-admin platform_support, inactive admin, unallowlisted role
and denied finance capability. Financial RLS tests exercise expired memberships,
suspension, disabled users, tenant/branch isolation and explicit capability
semantics against their actual imported helper migrations.

Important phase distinction: migration 120000's postflight requires the old
browser SELECT grant. It must not be blindly replayed after migration 150000
has deliberately revoked that grant. This review does not claim that restarting
the whole seven-file batch unconditionally is idempotent. The release runner
must classify exact retained history instead of replaying already-applied files.
The new `test-supabase-security-preflights.mjs` imports the exact migration bytes
and exercises 13 adverse catalog cases across supplier, company-account,
platform-support and default-privilege fixtures. Missing dependencies, disabled
RLS, missing service SELECT/EXECUTE, unexpected helper owner/SECURITY INVOKER,
anon EXECUTE, unreviewed function/schema defaults and missing required schemas
all returned their precise expected rejection. Each case is enclosed in an outer
ROLLBACK and an exception subtransaction. All 13 cases passed on PG17 and are
registered in the workflow after their synthetic fixture databases are populated.

Not every adverse preflight or provider configuration has been simulated; this
is not blanket authorization to apply the sequence.

## Consumers and server bypass review

- `powerhub-inventory-router.ts`: supplier directory resolves `viewSuppliers`
  and filters by the resolved tenant. Purchase headers/details resolve access
  before service-role table reads; child reads are bound to scoped parents.
  Supplier statement and aging resolve `viewSupplierLedger`, then pass resolved
  tenant plus requested authorized site to service-only RPCs. Phase D resolves
  current capabilities and filters financial categories. Payment allocations
  validate tenant, site, supplier and opening-ledger type before disclosure.
- `powerhub-maintenance-router.ts:listAssignableSuppliers`: `manageMaintenance`
  precedes a service-role query restricted to resolved tenant and active suppliers;
  the projection is only id/code/name, not financial supplier details.
- `powerhub.ts:deltaSync`: dynamic inventory feed dispatch was inspected.
  Supplier snapshot/pull uses `viewSuppliers`; procurement headers use purchase
  permissions. Supplier-ledger revisions expose opaque scoped cursors, not a
  generic row-level supplier-ledger feed.
- Browser `.from`/`.rpc` calls were searched across client source; no direct
  supplier table or targeted financial RPC call was found. Identified UI paths
  use tRPC and scoped offline caches. This static search does not prove absence
  of every constructed string, external client or deployed API exposure.
- Existing inventory/maintenance/guard tests: **113 tests passed**. These mock
  server access resolvers and therefore complement, rather than replace, actual
  SQL role/RLS tests.

## History reconciliation and finance/performance boundary

`pr359-migration-history-crosswalk-20261108.json` records all 28 unresolved names
from the handoff, their current source paths/versions, byte SHA-256, Git blob and
last file-change commit. There are 29 source files because one name has multiple
versions. Live history rows, stored hashes and object postconditions are null,
and every outcome remains `NOT_PROVEN`. Do not add together overlapping counts
from the older live inventory, or infer applied state from matching names.

Additional actual isolated SQL runs: `subscriber_balance_ledger_application_scope`,
`financial_settlement_approval_controls`, and `financial_settlement_ledger_derived`:
**PASS**. These establish their named source/approval/ledger contracts, not a full
audit of alternate-account deposit refund, all accounting effective dates, or
concurrent credit consumption. Those remain open. No production advisor count
was remeasured and no index change is proposed without plans/workload evidence.

## Reproduction

Use PostgreSQL 17 and a separate database for each SQL fixture. From repository
root, execute `psql -X -v ON_ERROR_STOP=1 -f supabase/tests/<fixture>.sql` against
that isolated database. For the new release guard fixture, set PGHOST=127.0.0.1,
PGPORT, PGUSER and PGDATABASE=supabase_migration_release_guard_test; create that
empty database, then run `node scripts/test-supabase-migration-release-guard.mjs`.
Do not point fixture commands at a hosted project. Repository CI contains the
exact database creation and invocation commands.

## Remaining release gates

1. Allow `api.github.com` and verify PR #359 remains OPEN/DRAFT, latest remote
   HEAD and all four required workflow conclusions on that exact SHA.
2. Obtain an authorized read-only Supabase connection; capture fresh ledgers,
   function/trigger/role inheritance and exposed-schema evidence without secrets.
3. Resolve each crosswalk case with retained SQL and actual postconditions.
4. Complete adverse preflight/combined dependency coverage and the financial
   effective-date/refund/concurrency backlog before making broader claims.
5. Keep the Staging application request blocked. Any live application requires
   separate explicit user approval. No Production application is authorized.

## Immutable seven-file SHA-256 manifest

- `20261107120000_powerhub_inventory_supplier_site_rls_scope.sql`: `61ef589c003fc5089bf7762deed064d83023729d657375b6df04fa5b4af7e8e6`
- `20261107130000_powerhub_inventory_phase_d_supplier_allocation_scope.sql`: `2b8666d7d760cc7a0bacad22bf87b2c39b6a8df3fe230d653e4957752f4ef0c3`
- `20261107130443_powerhub_platform_support_identity_role_guard.sql`: `95352867377ced90a305afa90f363e035f8c3320a1fe70d41ac2cdb4e4f5f9e6`
- `20261107140000_powerhub_inventory_supplier_payables_allocation_scope.sql`: `9e2dec82274e07eb479f63cbbe75aaa0a12ece6b2002c630f1fca0bae5fd3b4e`
- `20261107143819_powerhub_company_account_capability_search_path.sql`: `166da85481e946dd76cd4ca15c4d3f1c7d34cdf2fa70c2119743792619a1aa0b`
- `20261107150000_powerhub_supplier_browser_read_acl_revoke.sql`: `954c688f1c5ca2e893fa2a8d57a000f5027f6d7d1943bf1fc3dcf07da40002c9`
- `20261107150951_powerhub_public_default_privilege_hardening.sql`: `b47889eb8e52c3cb94f3598250dd47be6bc9578e4d49ba1ec9a451b1c3e343fe`

## Final local validation of this change

- Frozen-lockfile installation refreshed the branch dependencies without changing lockfiles. The first TypeScript/full-suite attempt failed on missing express-rate-limit left over from the older main checkout; both were rerun after the frozen install.
- `pnpm check`: PASS.
- `pnpm test`: PASS; 1849 successful test executions across 61 runner groups. Three server integration tests are skipped; per-name UI exclusions are repeated by the repository runner and are not additional failed tests.
- `pnpm build`: PASS after dependency refresh.
- Migration inventory/runtime boundary checks: PASS (579 SQL files, 502 canonical 14-digit files, six pinned historical collision groups).
- PostgreSQL 17.11: five seven-migration fixtures, three financial fixtures, 13 adverse catalog cases, production-builder concurrency/rollback tests and >128 KiB UTF-8 payload/hash round-trip: PASS.
- `git diff --check` and Node syntax checks for changed/new release test scripts: PASS.
- At the time of the implementation commit, GitHub API access was blocked; subsequent direct HTML verification is recorded below. Local checks were not substituted for CI.

## Subsequent direct GitHub verification — immutable implementation SHA

The API remained blocked, but the ordinary GitHub web checks page was accessible.
Its embedded route state confirmed head
`f9f32ee223e54033292fce535f4c3aaccde2f269`, PR state `DRAFT`, and every listed
job successful at 2026-11-08 01:15 Asia/Hebron (2026-11-07 23:15 UTC).
The checks page was explicitly selected with that full SHA. Pull-request runs:

- [PowerHub CI — success](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/42424000780).
- [PowerHub Security — CodeQL, dependency audit/review success](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/42424000773).
- [Supabase Admin Guard — success](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/42424000826).
- [Reading Cycle PostgreSQL Integration — success](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/42424000828).

The corresponding push runs and SBOM also succeeded; they were not counted as
additional independent test coverage. The former baseline `83633d7c` was selected
separately and its four handoff pull-request runs were freshly confirmed successful.
No PR mutation was needed. The API limitation remains relevant to authenticated
log/re-run operations, but does not block reading these verified UI conclusions.

The separately prepared [application/recovery package](pr359-staging-security-recovery-20261108.md)
and [read-only catalog SQL](sql/pr359-security-readonly-preflight.sql) preserve the
no-live-writes boundary. The SQL was executed on a synthetic database only.
Any later documentation commit needs its own same-SHA verification; the links
above assert only the immutable implementation SHA, not a moving branch tip.
