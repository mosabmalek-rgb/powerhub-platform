# Optional field-reader subscriber distribution

## Product behavior
- The setting is optional and scoped to one tenant and branch.
- The owner may select any number of active field-app readers (2, 3, 4, or more); there is no fixed maximum of four.
- When disabled or not configured, every authorized field reader retains access to the complete active subscriber list for that branch.
- When enabled, each active subscriber is assigned to one selected reader.
- Subscribers with the same normalized address stay together. Address groups are allocated largest-first to the currently least-loaded selected reader. Subscribers without an address are allocated individually to the least-loaded reader.
- New subscribers inherit an existing assignment for the same normalized address when possible; otherwise the database trigger assigns them to the least-loaded selected reader.
- Changing the selected reader set rebuilds the branch assignment in the same database transaction. Disabling the setting clears assignments.

## Security contract
- Only an active owner can configure distribution.
- The database RPC validates each selected account's active tenant membership, technician profile, branch scope, active account state, required reading and field-app permissions, and suspension status.
- The settings table and configuration RPC are not directly accessible to anon/authenticated browser roles.
- Mobile API list reads and reading writes are filtered by the authenticated user ID; client-supplied reader IDs are never trusted.
- An idempotent replay must not disclose a reading belonging to a subscriber now assigned to another reader.

## Acceptance
- Run the disposable PostgreSQL integration for 2, 3, and more readers; address normalization/grouping; addressless subscribers; new subscribers; inactive subscribers; tenant isolation; invalid or suspended readers; reconfiguration; disable-to-all behavior; and table/RPC ACLs.
- Run Mobile API route tests for disabled full-list behavior and enabled reader-specific filtering, plus direct-write bypass and idempotency replay.
- Apply the migration to Staging only after the disposable SQL suite passes. Browser/Preview acceptance is a separate stage.
- Do not run this migration against Production as part of this change.
