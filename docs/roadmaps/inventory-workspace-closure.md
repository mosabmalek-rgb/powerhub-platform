# PowerHub Inventory, Fuel, Purchasing & Maintenance — Closure Register

**Status date:** 2026-10-23  
**Latest baseline:** `main` at `7e24c21486a5455fd05581e44aae8d834e78d074` (PR #322 merged; Vercel production deployment is `READY`)
**Historical baseline at Phase D:** `e3fce973e9326dec5971a965390dd93ce3420fdc`; latest baseline is recorded above
**Approved source:** the 19-page user-approved proposal for “إدارة الوقود والمخزون والصيانة PowerHub”.  
**Purpose:** durable source of truth for implementation across PRs and conversations. Do not treat visible tabs, capability names, or passing CI alone as proof that a workflow is complete.


## Latest verified state (2026-10-23; live repository and database checks)

- **Git and CI — last fully verified code/test head before this register-only update:** `c783f8583ebc645511116fcd6a2f8a6b1809695e` (main remains `7e24c21486a5455fd05581e44aae8d834e78d074`). All four required workflows passed on that exact tested head: [PowerHub CI #3776](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/39998100298), [Reading Cycle PostgreSQL Integration #1424](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/39998100322), [Supabase Admin Guard #3257](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/39998100384), and [PowerHub Security #3535](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/39998100311). The current commit updates this evidence register with post-staging results; its own final-head checks must be independently green before acceptance. Security's dependency audit passed, while CodeQL analysis and dependency review were skipped, not passed. The latest production deployment remains READY (`dpl_7qNvbAMocQuuDJdQiVaA2i4mmpoK`) on main SHA `7e24c21486a5455fd05581e44aae8d834e78d074`.
- **Vercel:** production deployment `dpl_7qNvbAMocQuuDJdQiVaA2i4mmpoK` for exact SHA `7e24c21486a5455fd05581e44aae8d834e78d074` is `READY`, with `powerhub-platform.vercel.app` alias. This deployment was automatically created by the merge; no manual redeploy was triggered.
- **Migration registry and schema drift:** the earlier staging history remains: `powerhub_core_financial_direct_dml_hardening` (`20261023151939`), `powerhub_generator_reading_direct_dml_hardening` (`20261023155106`), `powerhub_membership_rls_scope_alignment` (`20261023163926`), `powerhub_generator_reading_index_reconciliation` (`20261023164000`), `powerhub_expense_account_linkage` (`20261023164548`), `powerhub_financial_index_trigger_reconciliation` twice (`20261023165456`, `20261023165557`; replay disclosed, ledger untouched), and `powerhub_audit_entity_id_not_null` (`20261023170058`). The new `20261023175417_powerhub_site_membership_inventory_read_scope.sql` was applied to staging once and Supabase registered it as `powerhub_site_membership_inventory_read_scope` version `20261023175417`. Post-apply read-only comparison over the same 25 public tables found 376 columns, 287 constraints, 181 indexes, 11 non-internal triggers, and 75 table/role ACL entries in each environment. Column types/nullability/defaults, constraint sets, index definitions, trigger definitions and enablement, and ACL matrix now match in that measured set. The only constraint definition difference is `audit_logs_actor_platform_role_check`; production's expression still accepts NULL under PostgreSQL CHECK semantics, just as staging does. `audit_logs.entity_id` is `NOT NULL` in both and has zero NULL rows; `actor_platform_role` remains nullable (staging has 12/13 NULL, production 294/319), which is required by existing tenant-side audit writers that select a user's nullable `platform_role`; do not force NOT NULL. No claim is made that the 25-table comparison establishes global parity; the historical 33-table/238-index/10-trigger result was a narrower earlier snapshot. Production-only historical `public.meters`, `public.complaints`, and subscriber-lifecycle objects remain excluded until their current dependency is proven; do not replay broad `0006_powerhub_remaining_schema.sql`.
- **Maintenance ACL and RLS:** preventive-plan, work-order, alert-event, and audit tables exist in both environments with RLS enabled; direct `anon`/`authenticated` SELECT is denied; execution of `powerhub_maintenance_evaluate_due_plans(bigint,bigint)` is denied to those roles and granted to `service_role`.
- **Cron:** read-only live inspection at `2026-10-23 17:01 UTC` confirms production's `powerhub-invoice-notifications` Supabase Cron is active at `* * * * *`; the latest ten `cron.job_run_details` all ended `succeeded`, latest at `17:01:00 UTC`. Production has zero active preventive plans and zero open maintenance-alert events, so this proves scheduler health, not a due-plan notification run. Staging has no Cron schema/job; do not add another scheduler.
- **Populated maintenance-plan test:** a due plan was evaluated twice inside one staging transaction; the test asserted one overdue event, one in-app notification, and one audit-create row. Rollback completed and a read-after-rollback query found zero fixture plan, audit, owner-profile, or notification rows. No SMS provider was called and production remained read-only.
- **Direct DML and membership RLS:** staging has both ACL revocations applied (`powerhub_core_financial_direct_dml_hardening`, `20261023151939`; `powerhub_generator_reading_direct_dml_hardening`, `20261023155106`). `powerhub_membership_rls_scope_alignment` (`20261023163926`) makes the six core policies `TO authenticated`, enforces membership expiry and restricts platform bypass to active admin roles; helper ACLs were verified. Financial and generator/reading index/trigger reconciliations are applied and verified. The audit entity NOT NULL contract is applied at `20261023170058`; there were no NULL rows before or after. Production was queried read-only and not changed.
- **Authorization and CI evidence:** the inventory router has 32 mutation procedures; the source test suite now covers denied requests for all 32, including `recordFuelReading`, and asserts no DB/RPC call after denial. Maintenance denial/cost-guard tests are also present. The exact tested predecessor head above passed the complete PowerHub CI pipeline including tests and production build; current register-only revision must rerun and pass all required checks before acceptance.
- **Browser E2E:** **explicitly waived by the user on 2026-10-23. It is not run and is not represented as passed.** No Preview was created. Continue with source-level, CI, disposable PostgreSQL and read-only production checks. This waiver does not waive tenant/role testing, database integrity, migration review, or safe staging tests.

- **Cross-tenant RLS/security status:** staging now uses explicit active `has_tenant_access(tenant_id)` OR the allowlisted active platform-admin helper (`platform_owner`, `platform_admin`, `finance_admin`) for the 11 inventory/supplier read policies. The disposable PostgreSQL matrix verifies expired membership, plain nonmember, `platform_support`, each allowed admin role, `anon`, site `USING`/`WITH CHECK`, direct-DML revocation and `updated_at` trigger firing. **Production still has the 11 older policies expressed as `current_tenant_ids() OR is_platform_user()`**, and live function definitions confirm `is_platform_user()` includes any active non-null platform role, including `platform_support`. This is a real tenant-isolation gap in production. Staging was hardened rather than weakened to match production; do not call RLS behavior fully in parity or mark the security gate accepted until a separately reviewed production remediation plan is executed safely.
- **Staging rollout verification:** the follow-up migration is applied to staging exactly once, under registry version `20261023175417`; the source file is now named `20261023175417_powerhub_site_membership_inventory_read_scope.sql` to match that recorded version, with no manual edits to migration history. Post-apply checks confirm no direct client `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` on `sites` or `tenant_members`, SELECT remains as expected, `service_role` retains intended DML, both missing indexes and both `updated_at` triggers exist, trigger behavior passed disposable-Postgres verification, and scoped ACL/schema structures compare equal. Production was queried read-only only; no production migration/write/deploy was triggered by this work. **Release/merge gate remains blocked by the production cross-tenant RLS policy issue above** and current-head checks for this filename/doc follow-up.
- **Tooling limitation:** Vercel Sandbox refused a fresh workspace because the Hobby snapshot-storage limit was exceeded (HTTP 402; reset reported as 2026-11-01). No billing/security settings were changed to bypass it.

### Open acceptance gates by phase

- **A:** final-head capability review is pending. Table-driven tests now cover the previously uncovered 16 inventory lifecycle/stocktake mutations; the new maintenance-router suite adds denials for supplier assignment, due-plan evaluation, work-order creation/transitions/reopen, part issuance, preventive plans, report access, and cost guards before DB/RPC calls.
- **B:** scoped schema/ACL/RLS/index/trigger parity is now verified across 33 shared feature tables, 238 indexes and 10 triggers. Production-only legacy `meters`/`complaints`/retention objects are documented exceptions to the A–D feature-scope review rather than a claim of global schema parity.
- **C:** SQL integration covers overdue-alert dedupe/audit, idempotent stock parts, closeout costs, completion correction, reopen/follow-up, and tenant/supplier guards. Release accounting behavior is report-only for labour/external-service costs—no automatic posting to expenses or company-account transactions until an idempotent source-of-truth posting key is approved, avoiding double counting. Recurring faults are report-only groups by generator and case/whitespace-normalized title within the selected local-date range; `breakdown_count` reports breakdown events. No automatic escalation or duplicate work-order threshold is configured.
- **D:** source/CI tests cover period/generator/warehouse filters, full keyset loading of filtered movements, CSV escaping, multi-sheet Excel and Arabic RTL PDF bounds. Browser E2E and actual browser downloads remain explicitly waived and are not claimed as passed.

## Non-negotiable delivery rules

1. Implement each cohesive workstream across schema/migration, guarded server procedures, UI, audit/idempotency, tests, and user-facing errors together.
2. Do not perform sample purchasing, payment, inventory, or ledger mutations against production. Use disposable PostgreSQL integration fixtures and staging-only end-to-end scenarios.
3. No direct silent edits/deletes to historical stock or financial records. Use append-only movements, compensating entries, reasons, actor/time audit, and locked-period checks.
4. Never allow negative stock, cross-tenant/cross-site object references, out-of-scope company accounts, duplicate effects on retries, or unguarded direct RPC access.
5. Purchasing/inventory consumption are distinct financial events. A stock receipt/payment must not be charged again as an operating expense when materials are issued/consumed.
6. Reuse existing company accounts, PowerHub cycle definitions, role/permission admin surfaces, audit log, notifications, and export utilities. Do not build parallel versions.
7. Keep work grouped into coherent PRs. A phase is done only after code review, CI, database integration, authorization tests, migration review, safe staging checks, and production/staging schema parity checks. Browser E2E may be waived only by explicit user instruction and must be documented as not run, never as passed.

## Final approved horizontal tabs

The final workspace should expose these nine logical tabs beneath the single “المخزون والمشتريات والصيانة” header; implementation can share components internally but must not lose any function:

- [x] لوحة التحكم — source-backed inventory, supplier debt, fuel measurement, maintenance, procurement/settlement and per-generator recorded operating-cost indicators by selected branch and period.
- [x] دليل الأصناف — create/view/edit/deactivate; durable item code, category, base unit, reorder point, specification; duplicate protection and referenced-history guards.
- [x] المشتريات — supplier invoices and lines, purchase/due dates, unit conversions, discounts/tax/charges, draft/approval, physical partial/full receipts, and payment state.
- [x] Maintenance execution and preventive alerts are integrated with the shared workspace; Phase D adds maintenance costs and downtime to unified selected-branch reports, seven-sheet Excel, and branded RTL Arabic PDF. Acceptance evidence and unresolved policy decisions are tracked by phase below.
- [x] المخزون والحركات — per-site warehouses and stock locations/tanks, opening balances, receipts, issues, transfers, supplier/issue returns, stocktake, corrections/reversals, item balances and immutable movement history.
- [x] الموردون والذمم — supplier profile lifecycle, opening balance, account statement, invoices, payments, returns/credits, outstanding balance, due/overdue aging.
- [x] دفعات الموردين — one or multiple invoice allocations, existing company-account selector, partial/full settlement, reference, reversal, atomic account/ledger/audit effects.
- [x] الوقود والاستهلاك — (Phase B) refuelling records, source/target tanks, historical fuel-level and operating-hour readings, measured actual consumption where inputs support it, litres/hour, alerts, reports.
- [x] الصيانة — (Phase C) work orders, breakdowns, preventive schedules, assigned staff, downtime, parts/oils, labour/external service cost, closeout, due alerts and machine history.
- [x] التقارير والتصدير — Phase A stock reports plus Phase D CSV, seven-sheet Excel and branded RTL Arabic PDF for stock, paginated movements, procurement/settlement/returns, fuel measurement and maintenance costs; final release gates remain open below.

## Phase A — close stock, purchasing, suppliers and payables

### Implemented baseline (verified in code / migrations / integration test history)

- [x] Unified `/inventory` route, shared branch selection, horizontal mobile-scrollable workspace.
- [x] Item, supplier and warehouse create/list foundations. Defining an item does not change quantity.
- [x] Purchase drafts/lines and confirmation; partial/full physical receiving with stock and supplier payable linkage.
- [x] Existing company-account options and atomic supplier-payment posting tied to invoice allocation and supplier ledger.
- [x] Supplier ledger statement; safe purchase cancellation and supplier-payment reversal.
- [x] Opening stock, manual issue, stock adjustments, fuel-consumption stock movement, issue returns and movement correction.
- [x] Atomic same-site warehouse transfers.
- [x] Integrated supplier returns; exact cost handling for partial receipt, stock issue/returns and supplier returns.
- [x] Stock balances and movement report with keyset paging and complete filtered CSV export; Phase A multi-sheet Excel and branded RTL Arabic PDF added.
- [x] Per-staff capability override infrastructure and server-side authorization; operation-specific create/edit/deactivate and independent supplier-payment reversal capabilities are covered at UI/server/SQL layers. Owner-profile override scope remains an explicit open decision.
- [x] PostgreSQL integration gates include purchase receiving, idempotency, audit rollback, tenant isolation, concurrent inventory/payment scenarios and permission checks.

### Remaining Phase A acceptance checklist

Phase A implementation and reconciliation rehearsal are merged. Recent main-head CI and PostgreSQL evidence is linked in the verified-state section. Remaining gates are the operation-by-operation capability/denial review and comprehensive migration/schema parity; the user's Browser E2E waiver is recorded and is not counted as a passed UI test.

- [x] Complete item lifecycle: guarded edit/deactivate, duplicate-code handling, referenced-history preservation and audit.
- [x] Complete supplier lifecycle: edit/deactivate; address/tax fields exposed while historical finance records are preserved.
- [x] Complete warehouse/location lifecycle and model central warehouse, branch warehouse, fixed fuel tank and generator-associated tank with tenant/site-safe generator linkage.
- [x] Full stocktake workflow: session/date, counted quantity, system quantity, variance, reason, approval, posted adjustment and audit; stale submitted counts can be safely cancelled and replaced.
- [x] Durable item-level purchase units: unique per-item labels, positive six-decimal conversion factor, immutable conversion snapshot on purchase lines, no unconfigured units or client-forged factors, audited deactivate/reactivate, and guards against changing the base unit after purchase units exist. PostgreSQL integration, UI contract, TypeScript and production build gates passed on `4c1a631dd49772914dce471b0664b27e6d4decf5`.
- [x] Supplier opening payable balance with traceable date/reference/reason and balanced ledger representation.
- [x] Supplier payment batch allocated to multiple invoices/opening balances, with row locks, amount validation, idempotency, company-account movement, ledger postings and audit in one transaction.
- [x] Purchase payment state is derived from posted ledger activity rather than an unposted intent flag: invoice details distinguish paid in full, partially paid/credited, and on-account/unpaid; the payment action records the company-account movement, invoice allocation and supplier-ledger entry in one transaction with idempotency. UI-contract tests assert all three states, and the staging database rehearsal verified partial multi-invoice allocation and reversal without duplicate account movement.
- [x] Supplier payable aging: not-due and 1–30/31–60/61–90/91+ overdue bands and totals, scoped by tenant/site and financial-view permission.
- [x] Supplier/payables details: supplier ledger and payment history are available; the aging report exposes as-of-date buckets and exports its full rows and totals to a right-to-left Excel worksheet and Arabic PDF.
- [x] Database-level reconciliation rehearsal on staging: two purchases (partial then complete receipts), opening payable, one payment allocated across two invoices, supplier return, payment reversal, warehouse transfer, issue/return, stocktake posting, final stock quantity/value and supplier aging totals all reconciled inside one transaction. The deliberate rollback sentinel aborted the transaction, and follow-up counts confirmed no fixture item, supplier, warehouse, purchase, payment, return or stocktake remained.
- [x] Owner and staff individual capability overrides are both supported; administration shows effective permission outcomes and records role-policy, staff-override and owner-override changes in the existing security/permission audit stores.
- [ ] Finish the operation-by-operation capability matrix review (view/create/edit/deactivate/approve/receive/pay/reverse/stocktake/report) and verify all denials at the final branch head; UI/RPC/audit assertions alone do not close this gate.
- [x] UI-contract tests and disposable PostgreSQL integration assertions cover lifecycle, stocktake, units, opening balance, batch payments, aging, permissions, idempotency, tenant isolation and reconciliation scenarios.
- [x] Tenant audit-role compatibility: platform roles are preserved, tenant actors remain `NULL` in `audit_logs.actor_platform_role`, and item-unit deactivation reasons are stored in the shared `metadata` JSONB column rather than a nonexistent `reason` column. Staging smoke checks passed after correction.
- [x] Phase A FK index review: added indexes for item-unit actor, stocktake actor and stocktake item FKs; the post-migration staging advisor query no longer reports unindexed FKs for `inventory_item_units` or `inventory_stocktakes`.
- [x] Staging database E2E rehearsal (rollback-only): draft/confirm -> partial and full receipts -> opening payable -> multi-invoice payment -> supplier return -> payment reversal -> issue/return/transfer -> stocktake posting -> stock and aging reconciliation. Explicitly verified fixture counts returned to zero after rollback.
- [x] Browser E2E acceptance exception: explicitly waived by the user on 2026-10-23; no browser test was run and none is claimed as passed. Do not deploy a Preview that could fall back to production configuration.
- [ ] Complete one comprehensive migration-identity/schema-parity diff for phases A–D and record intentional differences. Key B2, Phase D and maintenance migration families are individually recorded in both environments; do not run purchasing/payment/stock mutations against production.

**Phase A exit gate:** remaining non-browser gates must be closed: operation-by-operation authorization denials, comprehensive schema/migration parity, green final-head CI, no RLS/ACL/tenant/site/account leakage, and reconciled stock/supplier/account ledgers under retries/concurrency. Browser E2E is an explicitly user-approved waiver, not a passed test.

## Phase B — measured fuel and consumption (implementation and release status)

- [x] Model independent stock locations/tanks and source/target tank relations (implemented in the Phase A location-type migration; Phase B reuses that model).
- [x] Append-only refuelling events: generator, date/time, litres, source item/location, destination generator tank, cost, level before/after, meter hours, reference and actor (B1 / PR #318).
- [x] Append-only dated tank-level and operating-hour readings; reject backwards readings except documented corrections (B1 / PR #318).
- [x] Keep received/filled, stock movement outflows, recorded consumption, and measured consumption distinct.
- [x] Calculate actual use from opening tank level + fills/inflows - stock outflows - ending tank level; return explicit insufficient-reading or reconciliation-anomaly status rather than inventing consumption.
- [x] Compute litres/hour only with a valid positive operating-hour delta; no rate is fabricated without sufficient meter readings.
- [x] Configurable low-level and abnormal-measured-use alerts, episode-state deduplication, recovery/re-arm, and audited idempotent settings.
- [x] Report by day, configured PowerHub reading cycle, month, and custom range, with site/generator/tank filters and fill cost/quantity.
- [x] Server/RPC authorization, tenant/site scoping, append-only ACL, idempotency/concurrency assertions, PostgreSQL integration tests, and the 11 fuel-domain FK support indexes.
- [ ] Release acceptance: final-head CI green and comprehensive staging/production migration/schema parity review. Browser E2E is explicitly waived by the user on 2026-10-23 and is not counted as passed.

### Phase B1 — auditable fuel-entry and measured-consumption foundation

**PR #318 — B1 merged into main.** The merged delivery adds append-only fuel-fill events tied to atomic stock transfers and dated tank/hour readings with documented corrections. Read-only checks confirm the B1 schema and ACL migration in both `powerhub-staging-dr` and production.

B2 reporting and alert evaluation were merged in PR #319. The three B2 migration families—report windows, alert settings/evaluator, and fuel-domain FK indexes—are recorded in both staging and production. Main-head PowerHub CI, PostgreSQL integration, Admin Guard, Security and Operations Smoke are green as linked above.

The Phase B release gate remains open for comprehensive migration/schema parity. Browser E2E was explicitly waived by the user on 2026-10-23 and is not counted as passed. No SMS sends or production stock/financial test mutations were performed in this review.

## Phase C — maintenance implementation merged (acceptance gates remain open)

- [x] Tenant/site/generator-scoped work orders with unique numbers, type, priority, fault/work summary, dates, assigned staff/supplier, downtime, spare-part cost, labour/service cost capture and total cost.
- [x] Lifecycle states: scheduled, new, in progress, waiting for parts, completed and cancelled; invalid transitions and cancellation without a reason are rejected.
- [x] Correct completed work orders through an explicitly audited record-only workflow requiring a reason and corrected summary; it preserves the close-out operating-hours reading, stock movements, preventive-plan schedule and alert state, and never posts a second expense.
- [x] Reopen completed work orders as a new linked execution cycle with mandatory reason, a fresh work-order identity, idempotent retry and audit; the original completion, costs, stock issues and meter readings remain immutable and are not copied into the follow-up order.
- [x] Preventive plans by calendar date and/or operating hours; due-soon/overdue detection and next-due advancement on linked preventive close-out.
- [x] Spare-parts/oils issue linked to the work order and stock ledger, with atomic rollback and operation-key idempotency.
- [ ] Define any required accounting/expense posting policy for labour and external services; current maintenance costs are captured and reported but are not automatically posted to company accounts. Duplicate posting is prohibited until a source-of-truth expense ledger and idempotent posting key are defined.
- [x] Atomic close-out records completion actor, effective operating-hour reading, generator last-maintenance timestamp, linked plan advancement, cost totals and immutable maintenance audit.
- [x] Deduplicated in-app preventive alerts and per-generator/date-range CSV cost/downtime summary.
- [ ] Complete role-by-role capability verification, broader tenant/site/generator isolation and rollback acceptance, and recurring-fault semantics review. Phase D supplies unified maintenance-cost/downtime reporting and branded Excel/PDF exports; financial and inventory reconciliation still needs comprehensive acceptance evidence. Browser E2E is explicitly waived by the user on 2026-10-23 and is not claimed as passed.

## Phase D — dashboard, reporting and release closure (implementation complete; acceptance gates open)

- [x] Dashboard metrics now load from canonical inventory, supplier-aging, cycle, fuel, maintenance, and procurement/settlement sources. Missing/failed sources are shown as unavailable, not fabricated zeroes.
- [x] Unified selected-branch, generator, warehouse, category, item/search, day/configured-cycle/month/custom-period filters. The shared workspace's branch selection remains the branch scope; stock and movement filters are explicit, while supplier totals remain document/branch-period values rather than being falsely allocated to stock categories.
- [x] Completed selected-branch reports for stock balances/low stock, keyset-paginated inventory movements, approved purchase invoices, posted supplier payments, supplier return credits, payable aging, filled fuel, measured actual use, maintenance breakdown/cost/downtime, and generator-by-generator recorded fuel-transfer and maintenance costs.
- [x] Inventory purchases, cash settlements, supplier-return credits, fuel transfer value and work-order costs remain distinct financial event types. A purchase or payment is not added again as a new operating expense; incomplete tank readings do not produce a partial value labeled as total actual consumption.
- [x] Unified CSV; seven-sheet Excel (summary, balances, movements, fuel, maintenance, generator operating-cost breakdown, procurement/payments/returns); branded right-to-left Arabic PDF with report logo when configured, selected branch, filters, Asia/Gaza timestamp, and a 2,000 movement/financial-event PDF cap. CSV user-controlled text is guarded against spreadsheet-formula injection.
- [x] Effective role/user permissions are visible in the existing platform administration surface. Role-policy updates and individual staff/owner overrides already use audited database RPC paths; no parallel permission system was added.
- [x] Added permission-denial and pagination contract tests for the Phase D summary/details RPCs, category metadata on movement pages, and disposable PostgreSQL reconciliation/ACL/keyset checks for the financial event detail ledger.
- [x] Applied and verified the summary/details RPC migrations in staging and production after PR #321 merge. Read-only checks covered signatures, `SECURITY INVOKER`, locked search path, role ACLs, valid summary/detail responses and purchase-only/supplier-only/hidden-all event filters. The full cross-environment schema diff remains an open gate; no production financial or stock transactions were used for verification.
- [x] Hardened financial detail paging so invoice/payment/return visibility flags are applied inside PostgreSQL before LIMIT and cursor creation. The server now passes the resolved capabilities to SQL and no longer derives cursors from rows it later masks. This closes a potential hidden-event cursor/date/id disclosure.
- [x] Merged-main automated gates are green on `e3fce973e9326dec5971a965390dd93ce3420fdc`: PowerHub CI (TypeScript, tests, production build), PostgreSQL integration, Supabase Admin Guard, Security and subsequent Operations Smoke. This is CI evidence, not full phase acceptance.
- [ ] Complete one comprehensive migration-identity/schema-parity diff for all A–D objects and record intentional differences. Key B2, Phase D and maintenance migration families are individually recorded in both environments. Do not run purchasing/payment/stock mutations against production.
- [x] Browser E2E is explicitly waived by the user on 2026-10-23. The UI test and actual CSV/Excel/PDF downloads were not run and are not claimed as passed; continue relying on source-contract, server authorization and export-generation tests.
- [x] Post-merge rollout checked read-only: Vercel production deployment `dpl_2k5aDwhgiuSbaedj4tEs18n8LwEE` is READY for PR #321 SHA; Phase D and maintenance migration families are recorded in both environments. Do not trigger another production deployment without a code or schema need.

## Phase B fuel completion package (2026-10-22)

B1 is merged as PR #318 and deployed. B2 was merged as PR #319; see the verified-state section for the current main SHA, CI evidence and migration status.

- [x] Fuel-fill events are linked to atomic stock transfers; tank-level and operating-hour readings are append-only and corrections are documented.
- [x] Service-role UPDATE/DELETE/TRUNCATE access to the fuel event and reading ledgers is revoked; server-side RPCs remain the write path.
- [x] Canonical report-window migration supports local timezone day, configured PowerHub reading cycle, calendar month, and custom ranges, filtered by generator and tank.
- [x] Fuel alert settings are scoped to tenant/site/generator/tank; save operations are idempotent and auditable.
- [x] Low-level and measured-abnormal-consumption alerts use episode state plus a unique dispatch key; only one in-app notification is produced for each transition into an active episode. No SMS provider is called.
- [x] New fuel reads/fills call the evaluator in their transaction. The existing protected Supabase Cron route calls the evaluator as a periodic backstop; no second cron job is added.
- [x] SQL integration coverage includes day/cycle/month/custom reports, alert activation/recovery/re-arm, operation-key replay/reuse, RLS and RPC/table privilege assertions.
- [x] Staging schema verification: all three B2 migration names are recorded and their tables/functions/indexes and RPC privileges were checked on `powerhub-staging-dr`.
- [x] Production schema rollout: the report-window, alert-settings/evaluator, and fuel foreign-key index migrations have been applied to production after confirming B1 dependencies and confirming none of the B2 tables/functions/migrations existed there beforehand. Post-apply schema/ACL/RLS/trigger/index checks and read-only RPC smoke calls passed.
- [x] Browser E2E waiver reaffirmed by explicit user instruction (2026-10-23): no UI test was run and it is **not** claimed as passed. No Preview was created or used.
- [x] CI and database verification: PowerHub CI, PostgreSQL integration, Supabase Admin Guard, Security and subsequent Operations Smoke passed on merged main SHA `e3fce973e9326dec5971a965390dd93ce3420fdc`.
- [ ] Future CLI migration workflow reconciliation: the Supabase MCP apply path records an execution-time version different from the Git filename timestamp. The repository currently has no automatic `supabase db push` release workflow; before introducing CLI-driven pushes, use the official Supabase migration-repair/list procedure to reconcile history. Do not manually rewrite ledger rows.

The abnormal-consumption alert is emitted only when the report returns a valid measured window and a sufficient positive operating-hours delta. Missing readings or reconciliation anomalies do not become fabricated zero-consumption or rate values. Preview evaluation remains disabled unless the dedicated `POWERHUB_ALLOW_PREVIEW_FUEL_ALERTS=true` opt-in is explicitly set.

## Phase B2 branch and release evidence (2026-10-22)

- PR #319 is merged as `b88932cd69a1c7574eef3daade39453389b1ff35`; PR #320 (Phase C) is merged as `44eb7b12833dd73164c074dd67318c3496d447a4`; PR #321 (Phase D) is merged as `e3fce973e9326dec5971a965390dd93ce3420fdc`. Current acceptance gates are summarized at the start of this register.
- The core B2 code head passed all four GitHub Actions gates: [PowerHub CI](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/39808151664) (TypeScript, tests, production build), [PostgreSQL integration](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/39808151798), [Supabase Admin Guard](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/39808151735), and [Security](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/39808152099). The added forward-only index migration also passed PostgreSQL integration, and Security/Guard passed on its implementation head. The latest documentation/index follow-up head is re-running all required gates; check live checks before merge. These results do not replace a browser end-to-end rehearsal.
- Both staging (`iyuryuhaylhisjfcrwkz`) and production (`vvcdiqcyhaloxesvpppc`) now have all three B2 migrations applied: `powerhub_fuel_report_windows`, `powerhub_fuel_alert_settings_and_evaluator`, and `powerhub_fuel_foreign_key_indexes`. The Supabase MCP records execution-time versions per environment (staging `20261022155753`, `20261022155913`, `20261022160631`; production `20261022162411`, `20261022162439`, `20261022162517`), while Git migration filenames use their authored timestamps. This project currently has no automated `supabase db push` workflow, so the schema rollout used the established MCP apply path; before introducing CLI-driven pushes, reconcile with the official Supabase migration-list/repair process rather than manually editing ledger rows.
- Read-only smoke calls to the report-period, alert-settings-list, and alert-dispatch-list RPCs using nonexistent tenant/site IDs returned zero rows without error in both environments. Production post-apply checks show four alert tables with RLS enabled, no direct SELECT for `anon`/`authenticated`, report/alert RPC execution restricted to `service_role`, both fuel insert triggers enabled, and all 11 supporting FK indexes present. Supabase Performance Advisor has no remaining unindexed-FK findings for the fuel domain.
- Post-migration schema verification found all four alert tables present with RLS enabled; `anon` and `authenticated` have no direct SELECT on those tables or EXECUTE on the report/alert RPCs; `service_role` has the expected function execution. The two fuel insert triggers are enabled. Supabase performance advisors originally identified 11 unindexed fuel-domain foreign keys; the forward-only index migration created all 11 supporting indexes, and a fresh advisor result no longer reports fuel-related unindexed foreign keys. This staging project has no `cron` schema, and the migrations create no Cron job; do not add a duplicate scheduler. Production has not been modified by this B2 review.
- At the earlier 2026-10-22 check, this branch lacked verified staging-only Preview bindings. The user explicitly waived Browser E2E; no Preview was created for this closure work and no browser test is claimed as passed.
- Later merges deployed Phase B through Phase D; PR #321's production deployment is READY on the current main SHA. Browser E2E remains explicitly waived, not passed. No SMS or production stock/financial test mutations were performed during this closure review.

## Historical gap snapshot (2026-10-22; superseded by the live-state section above)

- The approved nine logical tabs are implemented across inventory, purchasing, suppliers/payables, fuel, maintenance, dashboard and reporting components. Tab presence does not replace phase acceptance.
- The statements in the original snapshot below describe findings as of 2026-10-22 only; current migration, maintenance RLS/ACL, export and deployment evidence is summarized above. Do not treat the historical snapshot as current schema status.

## Update protocol for every future conversation

Before editing:
1. Read this register first.
2. Read the approved source document (19-page proposal) when available.
3. Inspect current main SHA, open PRs, migrations in both environments, and relevant tests.
4. Reconcile the checklist with actual code; never infer completion from an old conversation summary alone.

After each cohesive PR:
1. Update checked items and the verified baseline SHA/PR/check results here.
2. List newly discovered gaps instead of silently narrowing scope.
3. Do not mark staging/production end-to-end complete unless actually executed and evidenced.
4. Carry this file and this path into new conversations: `docs/roadmaps/inventory-workspace-closure.md`.

## Phase C — Generator maintenance and breakdown management

Status: implementation merged in PR #320 and included in Phase D reporting in PR #321. Automated code and database gates passed on merged main; acceptance still has open accounting-policy, role/tenant-isolation, recurring-fault and schema-parity questions described above.

### Scope delivered in this branch
- Tenant/site/generator-scoped maintenance work orders with validated lifecycle transitions, closeout summary, downtime, operating-hours checks, labour/service/parts costs, and append-only audit events.
- Spare-parts issue is executed through the existing stock-movement RPC inside the same PostgreSQL transaction as the work-order part row and recalculated order costs. Operation keys are payload-bound and replay-safe; insufficient stock or later insert/audit failure rolls the transaction back.
- Preventive plans support date and/or operating-hour intervals, due-soon thresholds, overdue alerts, cycle-key deduplication, and resolution when a work order completes.
- Direct table access is revoked from `anon` and `authenticated`; API requests go through authenticated server procedures with the existing `manageMaintenance` capability, plus `issueInventory` for parts and `manageExpenses` for closeout costs.
- The inventory workspace has a maintenance tab for creating and tracking breakdown work orders and performing state transitions.
- Added a disposable PostgreSQL integration script and a required workflow step, plus router/schema contract tests.

### Required closure evidence
1. Run the full required CI and PostgreSQL workflow on the final branch head.
2. Fix any migration/test failures; do not weaken assertions to obtain a green run.
3. Verify migration against a clean PostgreSQL 17 database and confirm cross-tenant generator, item, warehouse, assignee, and work-order references are rejected.
4. Add/verify concurrency and failure rollback cases for concurrent duplicate part issues and stock movement failure.
5. Verify role policy and capability configuration UI exposes `manageMaintenance` consistently to owners/managers/technicians.
6. Keep the deployed migration list and actual schema under review; production data must remain read-only for testing.
7. Browser E2E was explicitly waived by the user on 2026-10-23. It was not run; do not report it as passed merely because component-contract tests pass.
