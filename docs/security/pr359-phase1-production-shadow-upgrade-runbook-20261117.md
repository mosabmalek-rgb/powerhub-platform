# PR #359 — Protected Production-derived Shadow upgrade acceptance

**Status: BLOCKED / NOT TESTED.** This is an execution specification, not proof of a restore or authorization to deploy.

## Mandatory prerequisites
- Approved isolated PostgreSQL 17 environment, verified network/role isolation and encrypted storage; secure retention and destruction policy. Confirm project provisioning cost and approvals separately.
- Backup provenance: timestamp, snapshot identifier, original Production project `vvcdiqcyhaloxesvpppc`, PostgreSQL/extension versions, roles, database parameters and schema migration ledger.
- Only protected/authorized production data may be restored; otherwise use an approved masked equivalent, record all non-equivalent data features explicitly. A new Supabase development branch **does not copy Production business data** and is not a substitute.
- SHA-pinned source/CI and verified dependency-ordered migration shortlist. Do not release all Git-only migration files indiscriminately or rewrite historical `schema_migrations`.

## Procedure (only in verified Shadow)
1. Verify backup integrity, restore permissions, pgcrypto/pg_cron/pg_net and other extension availability; establish sanitized pre-upgrade schema/row-count/accounting baselines and ledger SHA; record backup provenance, without exporting private row values into CI.
2. Classify each candidate by both current SQL history and catalog/object/ACL/RLS/function-body **and behavioral postconditions**. Resolve `UNPROVEN`, `DIVERGENT`, duplicate names, differently versioned names and source collisions **before** applying a candidate. Preserve original ledger.
3. Apply the smallest approved forward-only ordered patch set using the protected transaction-aware release workflow, not ad-hoc SQL. Stop after any unknown/failure; never blindly retry.
4. Verify data counts, unique/FK constraints, RLS/ACL, tenant/site scope, double-entry and subledger balances, subscription lifecycle, dashboard collection semantics and offline journal/Outbox guarantees; ensure zero unexplained differences.
5. Restore a **fresh second copy** from the identical baseline snapshot, execute the exact ordered upgrade again and compare postcondition fingerprints.
6. Restore a **fresh third copy** for a deliberate failure scenario at a controlled mid-upgrade boundary; verify atomic rollback where supported, mark nontransactional effects and demonstrate documented restore/resume from verified baseline. No assumption that every DDL or external effect rolls back automatically.
7. Produce reviewer-signed restore/upgrade/repeat/recovery report SHA-256s, approvals, residual risks, and immutable link to tested PR SHA. Delete protected Shadow copies only following approved retention.

## Blocking gates
`MIGRATION_RECONCILIATION_PASS` requires a reviewable, comprehensive source/history and catalog/behavior crosswalk, not merely a successful CI check.
`PRODUCTION_SHADOW_UPGRADE_PASS` requires actual protected restore, two identical upgrade runs, failure recovery and no unexplained data/financial changes.
**Never** promote PR #359 or change Production while either gate is open.
