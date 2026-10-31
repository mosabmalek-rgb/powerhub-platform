# PR #359 — Staging migration and browser acceptance gate
**Date:** 2026-10-31  
**Status:** Draft / not merged. This is a release checklist, not an authorization to apply migrations or deploy.

## 1. Current evidence

- The PR source, disposable PostgreSQL migrations/assertions, TypeScript, Vitest, production build, Security and Supabase Admin Guard have passed together on a single reviewed head before this checklist was added. Re-run all four required workflows on the new final SHA after this documentation change.
- The PostgreSQL integration suite proves the SQL invariants in isolated databases. It does not prove that the migrations have been applied to a live Staging project or that the browser UI passes end-to-end acceptance.
- The read-only Staging audit found **32 PR migrations absent** from the Staging migration ledger. The ledger history differs between Production and Staging; raw ledger row counts or version-name matches are not a replay plan.
- No migration from this PR has been applied to Staging or Production. No Preview has been deployed, and no live stock, HR, payment, SMS, or financial mutation was used for validation.

## 2. Migration ordering and dependency groups

Apply only after the release owner reviews the actual Staging object/ledger diff and approves a Staging-only run. Preserve chronological order within each dependency group; do not replay every migration from either environment.

### A. Domain Delta read models and source journals
1. `20261027110000_powerhub_delta_invoice_history.sql`
2. `20261027130000_powerhub_delta_payment_history.sql`
3. `20261027140000_powerhub_delta_expense_history.sql`
4. `20261027150000_powerhub_delta_company_account_history.sql`
5. `20261029000000_powerhub_delta_inventory_catalog.sql`
6. `20261029100000_powerhub_delta_inventory_stocktakes.sql`
7. `20261029110000_powerhub_delta_purchase_headers.sql`
8. `20261029120000_powerhub_delta_receipt_return_headers.sql`
9. `20261029130000_powerhub_delta_fuel_maintenance_read_models.sql`
10. `20261029140000_powerhub_delta_fuel_events_maintenance_orders_parts.sql`
11. `20261029150000_powerhub_hr_delta_sync.sql`
12. `20261029160000_powerhub_hr_offline_operation_idempotency.sql`
13. `20261029192000_powerhub_offline_expense_idempotency.sql`
14. `20261030100000_powerhub_supplier_ledger_revision.sql`
15. `20261030110000_powerhub_hr_financial_delta_sync.sql`

### B. RLS, trigger and browser write-boundary reconciliation
16. `20261030150000_powerhub_inventory_trigger_acl_hardening.sql`
17. `20261030180000_powerhub_inventory_delta_bounded_membership_reconcile.sql`
18. `20261030200000_powerhub_browser_direct_dml_acl_reconcile.sql`
19. `20261030210000_powerhub_canonical_tenant_rls_policy_reconcile.sql`
20. `20261030220000_powerhub_missing_idempotency_schema_reconcile.sql`
21. `20261030230000_powerhub_missing_production_triggers_reconcile.sql`
22. `20261030240000_powerhub_chat_rls_scope_reconcile.sql`
23. `20261030250000_powerhub_chat_support_conversation_scope_hardening.sql`

### C. Domain idempotency, payment documentation and RPC contract reconciliation
24. `20261031120000_powerhub_inventory_stocktake_count_idempotency.sql`
25. `20261031130000_powerhub_payment_documentation_admin_precedence_reconcile.sql`
26. `20261031131000_powerhub_payment_documentation_public_rpc_reconcile.sql`
27. `20261031132000_powerhub_offline_operation_type_contract_reconcile.sql`
28. `20261031140000_powerhub_package_and_chat_schema_reconcile.sql`
29. `20261031160000_powerhub_invitation_rpc_idempotency_reconcile.sql`
30. `20261031170000_powerhub_custom_permission_role_rpc_idempotency_reconcile.sql`

### D. Final invalidation and platform identity policies
31. `20261031200000_powerhub_adaptive_delta_realtime.sql`
32. `20261031210000_powerhub_platform_identity_rls_alignment.sql`

Before each group, verify its preflight dependencies on the actual Staging schema. If an object or migration identity is already present under a different historical name/version, stop and reconcile it explicitly; do not mark a migration as applied merely to skip it.

## 3. Required read-only post-apply checks

After each approved Staging batch, inspect the live catalog and migration ledger before moving to the next batch:

- Confirm all required tables, columns, indexes, triggers, functions and RPC signatures exist, and that the applied migration record is unique and matches the intended source.
- Confirm `powerhub_sync_scope_state` has RLS enabled and remains inaccessible for direct browser SELECT/DML; cursor access remains server-owned.
- Confirm `anon` has no HR table access; `authenticated` has only the intended SELECT grants on minimized HR projections/tables; `service_role` retains the backend DML needed for server RPCs.
- Confirm browser roles have no direct INSERT/UPDATE/DELETE/TRUNCATE on protected financial, inventory, fuel, maintenance, payroll and HR tables; verify idempotency RPCs remain server-only.
- Confirm Realtime is private, the Delta receive policy grants only SELECT, no browser INSERT policy exists for Delta topics, and the project-level public-channel setting remains disabled.
- Confirm platform RLS helper definitions now match the server identity contract: active `role='admin'` plus the allowlisted platform role. The legacy `is_platform_user()` name is only an admin compatibility alias; Platform Support must use its explicit platform capability, not cross-tenant RLS bypass.
- Confirm payment-documentation public context/status/target RPC definitions and grants match the intended environment contract; preserve the admin-disable precedence and read-only pending-status path.
- Confirm tenant/site isolation, membership expiry, subscription expiry/read-only-retention, RLS policy commands, and service-role grants after every relevant batch.

Any unexpected column/type constraint, row conflict, duplicate migration, ACL mismatch, missing dependency, or policy drift is a stop condition. Resolve it with a narrowly scoped forward migration and a disposable PostgreSQL test before proceeding.

## 4. Staging browser acceptance — not yet run

Run only after the approved Staging migration sequence and post-apply checks are complete, using designated Staging test accounts and test tenants/sites:

1. Authenticate online, load a selected tenant/site, then refresh and reopen the application offline. Confirm the correct scoped cache is restored and no stale user/site projection leaks.
2. Queue approved offline HR, fuel and inventory draft operations; reload offline; verify Outbox dependencies and stable operation IDs survive. Reconnect and confirm idempotent replay, server acknowledgements, conflict reporting and no duplicate effects.
3. Verify the Adaptive Delta behavior: immediate invalidation after a private marker, 30-second visible safety polling, 60–120-second fallback after Realtime disconnect, pause while hidden/offline, and recovery after reconnect.
4. Verify site switch, tenant switch, sign-out/sign-in, expired membership/subscription, and explicit 401/403. Only the denied scope projection may be cleared; never wipe unrelated cache or Outbox.
5. Verify inventory purchases/receipts/returns/transfers/stocktakes, fuel entries, maintenance orders/parts, HR employee/attendance/payroll-draft/advance requests, and payment documentation. Pending local requests must never appear as final approvals, posted stock/financial movements, or completed account receipts without server confirmation.
6. Verify dashboard KPIs and reports refresh independently by their own revision scopes and remain within the permitted site/all-branches authorization.
7. Capture browser evidence, network requests, server authorization outcomes, and post-sync database assertions. Do not use live supplier payments, final payroll approval, SMS dispatch or production financial/stock operations.

## 5. Release boundaries

- Keep PR #359 Draft/open while Staging schema reconciliation and browser acceptance remain incomplete.
- Do not deploy a Preview until all requested tabs are implemented and the Staging browser gate is approved. A Preview is not a substitute for live Staging schema or browser acceptance.
- Production migration application requires a separate explicit release approval and its own preflight/post-apply verification. Do not replay the Staging batch into Production blindly.
- No Production DDL/DML, real SMS, final financial posting, stock mutation, merge or deployment is authorized by this checklist.
