# PowerHub Inventory, Fuel, Purchasing & Maintenance — Closure Register

**Status date:** 2026-10-22  
**Baseline:** `main` at `43575b04506ebdf9354066d1ba79538c0f50730b` (verified after PR #318 merge on 2026-10-22)  
**Approved source:** the 19-page user-approved proposal for “إدارة الوقود والمخزون والصيانة PowerHub”.  
**Purpose:** durable source of truth for implementation across PRs and conversations. Do not treat visible tabs, capability names, or passing CI alone as proof that a workflow is complete.

## Non-negotiable delivery rules

1. Implement each cohesive workstream across schema/migration, guarded server procedures, UI, audit/idempotency, tests, and user-facing errors together.
2. Do not perform sample purchasing, payment, inventory, or ledger mutations against production. Use disposable PostgreSQL integration fixtures and staging-only end-to-end scenarios.
3. No direct silent edits/deletes to historical stock or financial records. Use append-only movements, compensating entries, reasons, actor/time audit, and locked-period checks.
4. Never allow negative stock, cross-tenant/cross-site object references, out-of-scope company accounts, duplicate effects on retries, or unguarded direct RPC access.
5. Purchasing/inventory consumption are distinct financial events. A stock receipt/payment must not be charged again as an operating expense when materials are issued/consumed.
6. Reuse existing company accounts, PowerHub cycle definitions, role/permission admin surfaces, audit log, notifications, and export utilities. Do not build parallel versions.
7. Keep work grouped into coherent PRs. A phase is done only after code review, CI, database integration, authorization tests, migration review, staging smoke/end-to-end, and production/staging schema parity checks.

## Final approved horizontal tabs

The final workspace should expose these nine logical tabs beneath the single “المخزون والمشتريات والصيانة” header; implementation can share components internally but must not lose any function:

- [x] لوحة التحكم — source-backed current inventory metrics and supplier debt; fuel/maintenance KPIs remain Phase B/C.
- [x] دليل الأصناف — create/view/edit/deactivate; durable item code, category, base unit, reorder point, specification; duplicate protection and referenced-history guards.
- [ ] المشتريات — supplier invoices and lines, purchase/due dates, unit conversions, discounts/tax/charges, draft/approval, physical partial/full receipts, and payment state.
- [x] Phase C maintenance now includes deduplicated in-app preventive due alerts and a site-scoped per-generator/date-range CSV report for recurring work titles, downtime, order counts and cost breakdown. Full shared Excel/RTL PDF exports and company-wide aggregation remain open.
- [ ] المخزون والحركات — per-site warehouses and stock locations/tanks, opening balances, receipts, issues, transfers, supplier/issue returns, stocktake, corrections/reversals, item balances and immutable movement history.
- [ ] الموردون والذمم — supplier profile lifecycle, opening balance, account statement, invoices, payments, returns/credits, outstanding balance, due/overdue aging.
- [ ] دفعات الموردين — one or multiple invoice allocations, existing company-account selector, partial/full settlement, reference, reversal, atomic account/ledger/audit effects.
- [ ] الوقود والاستهلاك — (Phase B) refuelling records, source/target tanks, historical fuel-level and operating-hour readings, measured actual consumption where inputs support it, litres/hour, alerts, reports.
- [ ] الصيانة — (Phase C) work orders, breakdowns, preventive schedules, assigned staff, downtime, parts/oils, labour/external service cost, closeout, due alerts and machine history.
- [ ] التقارير والتصدير — Phase A now includes stock balances/movements, supplier aging, complete filtered CSV, multi-sheet Excel and branded RTL Arabic PDF; purchase/fuel/maintenance/machine-cost report coverage remains to close.

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

The implementation commit `9aff03d7dc05834308c9af90e1662ba14f221469` passed PowerHub CI (TypeScript, full tests, production build), PostgreSQL integration, Supabase Admin Guard and PowerHub Security. The staging rehearsals exposed and fixed tenant audit-role and item-unit audit-schema mismatches. A documentation-only follow-up may trigger another CI run; verify the current PR head before merge.

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
- [ ] Review fine-grained capabilities against each operation (view/create/edit/deactivate/approve/receive/pay/reverse/stocktake/report); show the effective permission result in platform administration. Current per-staff overrides intentionally exclude owner profiles in their current RPC; resolve this against the approved “each user” intent explicitly before closure.
- [x] UI-contract tests and disposable PostgreSQL integration assertions cover lifecycle, stocktake, units, opening balance, batch payments, aging, permissions, idempotency, tenant isolation and reconciliation scenarios.
- [x] Tenant audit-role compatibility: platform roles are preserved, tenant actors remain `NULL` in `audit_logs.actor_platform_role`, and item-unit deactivation reasons are stored in the shared `metadata` JSONB column rather than a nonexistent `reason` column. Staging smoke checks passed after correction.
- [x] Phase A FK index review: added indexes for item-unit actor, stocktake actor and stocktake item FKs; the post-migration staging advisor query no longer reports unindexed FKs for `inventory_item_units` or `inventory_stocktakes`.
- [x] Staging database E2E rehearsal (rollback-only): draft/confirm -> partial and full receipts -> opening payable -> multi-invoice payment -> supplier return -> payment reversal -> issue/return/transfer -> stocktake posting -> stock and aging reconciliation. Explicitly verified fixture counts returned to zero after rollback.
- [ ] Staging browser/UI E2E: repeat the approved workflow through the actual deployed preview/staging UI, including PDF/Excel downloads and role-specific screens. No preview deployment was created because this PR branch does not have branch-scoped staging `VITE_SUPABASE_URL` / publishable-key settings; do not deploy a preview that could fall back to production configuration.
- [ ] Check staging and production migration identities/schema parity after deployment, without financial mutation of production.

**Phase A exit gate:** all checklist items above are closed or explicitly documented as a conscious product decision approved by the user; all relevant CI gates pass; no RLS/ACL/tenant/site/account leakage; stock quantity/value and supplier/account ledgers reconcile; retry/concurrency tests pass; staging UI end-to-end passes.

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
- [ ] Release acceptance: final-head CI green, safe staging-only Preview, real browser journey, and release/migration parity review.

### Phase B1 — auditable fuel-entry and measured-consumption foundation

**PR #318 — B1 merged into main.** The merged delivery adds append-only fuel-fill events tied to atomic stock transfers and dated tank/hour readings with documented corrections. Read-only checks confirm the B1 schema and ACL migration in both `powerhub-staging-dr` and production.

B2 reporting and alert evaluation are implemented on PR #319. The three B2 follow-up migrations are now applied to staging only: report windows, alert settings/evaluator, and fuel-domain FK support indexes. Their PostgreSQL integration suite passed on recent PR heads, and the core implementation passed all four required GitHub Actions workflows. The latest documentation/index follow-up head must still finish PowerHub CI before the final code gate is declared green.

The Phase B release gate remains open until a Preview is verified to use staging-only credentials and an actual browser E2E completes. No production B2 migration or SMS send was performed in this review. The existing inventory PostgreSQL integration workflow remains the CI gate; no separate workflow was added for this small follow-up migration.

## Phase C — complete maintenance (not yet complete)

- [ ] Work orders with unique number, type, generator, priority, symptoms/fault, dates, technician/vendor, downtime, work summary, parts/oils, labour, external service and total cost.
- [ ] Lifecycle states: scheduled, new, in progress, waiting for parts, completed; documented cancel/reopen/correction transitions.
- [ ] Preventive plans by time and/or operating hours; due-soon/overdue; next due is whichever trigger arrives first where configured.
- [ ] Link issues of stock parts/oils to the order; consume and value materials exactly once.
- [ ] Correct financial treatment for labour/external service, without duplicate company-account or expense posting.
- [ ] Atomic close-out updates last maintenance/hour reading/next due, actor/approver and audit.
- [ ] Notifications without duplicate dispatch; detailed generator maintenance history and recurring-fault/downtime/cost reports.
- [ ] Permission, tenant/site isolation, stock locks, idempotency and failure rollback tests.

## Phase D — dashboard, reporting and release closure (not yet complete)

- [ ] Dashboard with live aggregate values from canonical tables, not fixture/static values.
- [ ] Unified branch/generator/category/item/day/cycle/month/custom-period filters; reuse PowerHub cycle configuration.
- [ ] Complete inventory movements, low stock, purchases, supplier payments, payable aging, fuel fill/actual use, maintenance, and generator operating-cost reports.
- [ ] Separate inventory purchases from operating consumption to prevent duplicate cost.
- [ ] Complete CSV; multi-sheet Excel (summary/details/movements); RTL Arabic PDF with logo, branch, applied filters and report timestamp.
- [ ] Show effective permissions in administration and audit any policy change.
- [ ] Required gate run: type-check, full test suite/build, security, Supabase admin guard, PostgreSQL integration, all permission-denial and tenant/site isolation checks.
- [ ] Stage end-to-end and migration parity; production rollout only after explicit release gate and safe migration review.

## Phase B fuel completion package (2026-10-22)

B1 is merged as PR #318 and deployed. The remaining Phase B work is being assembled into one follow-up PR on `feat/inventory-phase-b-completion`.

- [x] Fuel-fill events are linked to atomic stock transfers; tank-level and operating-hour readings are append-only and corrections are documented.
- [x] Service-role UPDATE/DELETE/TRUNCATE access to the fuel event and reading ledgers is revoked; server-side RPCs remain the write path.
- [x] Canonical report-window migration supports local timezone day, configured PowerHub reading cycle, calendar month, and custom ranges, filtered by generator and tank.
- [x] Fuel alert settings are scoped to tenant/site/generator/tank; save operations are idempotent and auditable.
- [x] Low-level and measured-abnormal-consumption alerts use episode state plus a unique dispatch key; only one in-app notification is produced for each transition into an active episode. No SMS provider is called.
- [x] New fuel reads/fills call the evaluator in their transaction. The existing protected Supabase Cron route calls the evaluator as a periodic backstop; no second cron job is added.
- [x] SQL integration coverage includes day/cycle/month/custom reports, alert activation/recovery/re-arm, operation-key replay/reuse, RLS and RPC/table privilege assertions.
- [x] Staging schema verification: all three B2 migration names are recorded and their tables/functions/indexes and RPC privileges were checked on `powerhub-staging-dr`.
- [x] Production schema rollout: the report-window, alert-settings/evaluator, and fuel foreign-key index migrations have been applied to production after confirming B1 dependencies and confirming none of the B2 tables/functions/migrations existed there beforehand. Post-apply schema/ACL/RLS/trigger/index checks and read-only RPC smoke calls passed.
- [x] Browser E2E waiver recorded by explicit user instruction (2026-10-22): the actual UI test is intentionally skipped and is **not** claimed as passed. No Preview was created or used.
- [x] CI and database verification: PowerHub CI, PostgreSQL integration, Supabase Admin Guard, and Security passed on the code/documentation release head before this last evidence update; re-check the new final head before merge.
- [ ] Future CLI migration workflow reconciliation: the Supabase MCP apply path records an execution-time version different from the Git filename timestamp. The repository currently has no automatic `supabase db push` release workflow; before introducing CLI-driven pushes, use the official Supabase migration-repair/list procedure to reconcile history. Do not manually rewrite ledger rows.

The abnormal-consumption alert is emitted only when the report returns a valid measured window and a sufficient positive operating-hours delta. Missing readings or reconciliation anomalies do not become fabricated zero-consumption or rate values. Preview evaluation remains disabled unless the dedicated `POWERHUB_ALLOW_PREVIEW_FUEL_ALERTS=true` opt-in is explicitly set.

## Phase B2 branch and release evidence (2026-10-22)

- Current `main` SHA: `43575b04506ebdf9354066d1ba79538c0f50730b` (PR #318 merged). The consolidated Phase B2 work is tracked in [PR #319](https://github.com/mosabmalek-rgb/powerhub-platform/pull/319), ready for the final required checks after the explicitly waived browser E2E. Check the live PR head and compare status before merge; the branch is ahead of main and not behind at this verification point.
- The core B2 code head passed all four GitHub Actions gates: [PowerHub CI](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/39808151664) (TypeScript, tests, production build), [PostgreSQL integration](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/39808151798), [Supabase Admin Guard](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/39808151735), and [Security](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/39808152099). The added forward-only index migration also passed PostgreSQL integration, and Security/Guard passed on its implementation head. The latest documentation/index follow-up head is re-running all required gates; check live checks before merge. These results do not replace a browser end-to-end rehearsal.
- Both staging (`iyuryuhaylhisjfcrwkz`) and production (`vvcdiqcyhaloxesvpppc`) now have all three B2 migrations applied: `powerhub_fuel_report_windows`, `powerhub_fuel_alert_settings_and_evaluator`, and `powerhub_fuel_foreign_key_indexes`. The Supabase MCP records execution-time versions per environment (staging `20261022155753`, `20261022155913`, `20261022160631`; production `20261022162411`, `20261022162439`, `20261022162517`), while Git migration filenames use their authored timestamps. This project currently has no automated `supabase db push` workflow, so the schema rollout used the established MCP apply path; before introducing CLI-driven pushes, reconcile with the official Supabase migration-list/repair process rather than manually editing ledger rows.
- Read-only smoke calls to the report-period, alert-settings-list, and alert-dispatch-list RPCs using nonexistent tenant/site IDs returned zero rows without error in both environments. Production post-apply checks show four alert tables with RLS enabled, no direct SELECT for `anon`/`authenticated`, report/alert RPC execution restricted to `service_role`, both fuel insert triggers enabled, and all 11 supporting FK indexes present. Supabase Performance Advisor has no remaining unindexed-FK findings for the fuel domain.
- Post-migration schema verification found all four alert tables present with RLS enabled; `anon` and `authenticated` have no direct SELECT on those tables or EXECUTE on the report/alert RPCs; `service_role` has the expected function execution. The two fuel insert triggers are enabled. Supabase performance advisors originally identified 11 unindexed fuel-domain foreign keys; the forward-only index migration created all 11 supporting indexes, and a fresh advisor result no longer reports fuel-related unindexed foreign keys. This staging project has no `cron` schema, and the migrations create no Cron job; do not add a duplicate scheduler. Production has not been modified by this B2 review.
- The Vercel project is linked to this repository, but no Preview deployment exists for this branch. The matching branch-scoped frontend URL and publishable key currently belong to a different feature branch, and the Vercel API does not return the sensitive service-role key value for verification. Do **not** create/use a Preview or claim browser E2E until all three bindings are proven to point to staging; never fall back to production credentials.
- At the time of this update, Vercel production has not yet been verified on the merged B2 commit. The user explicitly waived the actual browser/UI E2E; this is an acknowledged release exception, not a passed UI test. No Preview was created, no SMS was sent, and no operational/financial test transaction was performed.

## Current verified gap snapshot (2026-10-22)

- The existing workspace has eight logical tabs before Phase B fuel work; this branch adds the ninth “الوقود والاستهلاك” tab. Final design remains nine logical tabs before the Phase C maintenance surfaces are assessed.
- Stock, purchasing and supplier-payables schema/RPCs are present in both production and staging.
- Database inspection did not find dedicated maintenance-order/preventive-maintenance tables/functions. The generator fuel-fill/level/hour-reading tables and functions were added in B1 (PR #318); B2 report windows and alert tables/functions are now applied to staging only.
- Stock/purchasing/payables tables in staging were empty at inspection time. Passing disposable PostgreSQL tests does not prove that a full staging UI journey has been run.
- CSV movement export is complete and paginated; approved multi-sheet Excel and branded RTL PDF are not implemented in this module.
- Verified main baseline for the current B2 closure work is `43575b04506ebdf9354066d1ba79538c0f50730b`; re-check main/PR state before each future implementation session.

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

Status: implementation in progress on `feat/inventory-phase-c-maintenance`. This section is not an acceptance claim until CI and the disposable PostgreSQL workflow pass.

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
6. Verify the deployed migration list and actual schema before any staging rollout; production rollout remains gated on merge/release approval.
7. Browser UI test is not part of this branch's claimed evidence until explicitly run; do not report it as passed merely because component contract tests pass.
