# PR #359 Staging security application package — NOT AUTHORIZED

## Decision and immutable source

This package prepares a review; it does not request or imply permission to apply
anything. PR #359 must remain open/draft. No Staging or Production migration,
history write, permissions change, transaction or provider operation is authorized.

The seven-file SHA-256 manifest and exact order are retained in
[engineering verification](pr359-engineering-verification-20261108.md).
The migration bytes were not changed by release-runner commit
`f9f32ee223e54033292fce535f4c3aaccde2f269`.
Never substitute a moving branch name for that manifest at an approved release.
The [28-name crosswalk](pr359-migration-history-crosswalk-20261108.json) remains
`NOT_PROVEN`; version/name/SQL hashes and live postconditions are still required.

## Read-only evidence collection, prepared but not run live

[pr359-security-readonly-preflight.sql](sql/pr359-security-readonly-preflight.sql)
starts `BEGIN READ ONLY`, sets a bounded statement timeout and ends `ROLLBACK`.
It reads only catalog metadata and the migration ledger. It does not read Vault
values, scheduled HTTP commands, business/customer rows or raw historical SQL.
It collects retained SQL hashes, table/column SELECT grants, RLS flags,
function owner/SECURITY DEFINER/search_path/EXECUTE metadata, exact Chat trigger
attachments, default ACLs and pg_net/pg_cron owner/schema/version metadata.

The entire file was executed successfully against the isolated synthetic PG17
fixture with a synthetic migration ledger. That validates SQL syntax/permissions
in that fixture, not live schema completeness or live project connectivity.
Use only an authorized read-only connection for each hosted project, retain the
project identity and observation timestamp, and capture the results separately.
A missing role/schema or denied catalog read is a blocked check, not a reason to
escalate privileges or change the live project.

`current_setting('pgrst.db_schemas', true)` may return NULL. NULL is UNKNOWN;
obtain the project's exposed-schema configuration separately. Schema USAGE and
EXECUTE grants alone do not prove REST exposure. Definition hashes identify a
snapshot but do not prove a whole historical migration is represented. Targeted
body/policy/index comparisons remain necessary for each crosswalk outcome.

## Preconditions before an application approval can be considered

1. Verify current PR/HEAD/base and same-SHA required CI. Preserve Draft and do not
   merge or mark ready. Record any later contributor changes before release.
2. Capture fresh, read-only Staging/Production catalog and history evidence.
   Do not use the historical row counts as current observations.
3. Reconcile missing/changed SQL and different-version/name cases individually;
   do not replay, rename or mark a row applied to bypass the guard. An existing
   exact version/name/hash is a no-op, not permission to rerun its SQL.
4. Verify the deployed server path resolves active membership, capabilities and
   tenant/site before service-role reads. Direct browser supplier reads are
   intentionally removed. Verify relevant deployed consumers and API exposure;
   local source/tests are not deployment evidence.
5. Review default privileges for postgres globally and per schema, including
   provider schemas. Preserve supabase_admin defaults and pg_net ownership,
   event triggers and Cron. Unexpected postgres-owned routines or per-schema
   defaults outside the reviewed set require a separate decision.
6. Obtain explicit user approval for the exact immutable file/hash and target,
   through the established protected release workflow. No approval exists now.

## Execution order after a separate explicit approval

The established protected versioned workflow remains the only proposed live
execution path. Keep project/URI/TLS validation and source-content/history guards.
One approved file runs per atomic transaction; do not concatenate the seven files
into an ad-hoc release or dispatch any workflow from this package automatically.

1. `20261107120000`: supplier restrictive site RLS. Requires the historical
   authenticated SELECT grants and existing site-access helper/columns/RLS.
2. `20261107130000`: Phase D allocation consistency; service-only invoker RPC.
3. `20261107130443`: active admin platform-support identity.
4. `20261107140000`: payable allocation consistency; service-only invoker RPC.
5. `20261107143819`: company helper empty search_path with preserved owner/ACL.
6. `20261107150000`: supplier browser table/column SELECT revocation.
7. `20261107150951`: future postgres default privilege hardening.

Stop after each file. Read back its exact version/name/retained SQL hash and its
specific catalog postconditions before proposing the next file. Never replay
step 1 after step 6 merely to test batch idempotency: step 1 requires the old
SELECT grants that step 6 deliberately removes. Missing postflight evidence
blocks continuation; it does not authorize a manual history edit.

## Locking, compatibility and operational risks

- Policy/function/ACL/default-ACL statements change catalog objects and can wait
  behind concurrent object DDL or transactions. Measure the actual live blocker
  situation read-only before scheduling an approved maintenance window. The
  isolated tests do not measure live contention or production query latency.
- The release transaction's advisory lock serializes cooperating release runners.
  It cannot protect against arbitrary external ledger writers that ignore that
  lock. Keep external writes out of the release window.
- The runner explicitly uses READ COMMITTED so a waiter rechecks both identities
  against a fresh snapshot after acquiring the lock, even when a session default
  is REPEATABLE READ. Concurrent same-name/different-version and same-version/
  different-name releases were tested against real PostgreSQL.
- Set reviewed finite connection, lock and statement time limits through supported
  release environment settings; do not terminate arbitrary backend sessions.
  Timeout/failure means stop and inspect, not disable the guard.
- Browser ACL revocation can break an undiscovered deployed direct consumer.
  The source review found scoped server/tRPC and Delta consumers, but deployed
  clients/API settings and real synthetic end-to-end acceptance remain gates.
- The global postgres PUBLIC EXECUTE default revoke affects future functions in
  all schemas. Existing function ACLs remain unchanged. Future provider routines
  may need explicit provider-managed grants; do not grant PUBLIC automatically.

## Failure, rollback and recovery

Before any separately approved apply, preserve the immutable source/hash, current
ledger snapshot and relevant function/policy/ACL/default-ACL definitions securely.
Do not include credentials or Vault values in evidence artifacts.

If SQL or ledger insertion fails before COMMIT, the runner's transaction rolls
back both migration effects and history. The new synthetic regressions verify
migration SQL failure and ledger-write failure after successful migration SQL.
An advisory lock is transaction-scoped and releases on rollback/disconnect.
Do not insert a compensating history row or mark a failed migration applied.

If a connection is interrupted around COMMIT, treat outcome as UNKNOWN. Read the
ledger and exact retained hash plus catalog postconditions through a new read-only
connection. Do not blindly retry SQL. A later runner invocation may classify an
exact payload as already applied; mismatch/unavailable payload requires evidence.

If a committed migration causes a compatibility regression, pause further release
steps. Prefer a separately approved, versioned forward repair preserving tenant/
site/capability boundaries. Do not automatically restore broad browser grants,
PUBLIC EXECUTE, the old search_path, provider defaults, or an old function body.
A selective reversal needs its own threat/dependency review and explicit approval.
Never delete or rewrite the original history row. Restoring a database snapshot
would affect business data and requires a separate recovery decision; it is not
a routine rollback for these metadata-only source changes.

## Acceptance evidence after an approved apply

Use read-only catalog/history checks on the hosted project. Perform mutating or
adversarial tenant/site tests only on disposable synthetic databases, as required
by the current user authorization. Do not create live tenants, issue payments,
refund deposits, send messages or take over devices for acceptance.

Required acceptance includes exact retained file hashes, function owner/path/ACL,
policy role/permissive-mode definitions, table/column browser denial and retained
service access, platform non-admin/inactive denial, invalid allocation rejection,
and preserved provider-owned defaults/objects. Missing deployed API exposure,
synthetic authenticated-browser acceptance or live history reconciliation remains
explicitly unresolved. Production Chat trigger ACL/generator-RPC parity is a
separate canonical release review; do not recreate already-applied Staging SQL.
