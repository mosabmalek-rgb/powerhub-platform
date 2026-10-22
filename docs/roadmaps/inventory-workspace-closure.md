# PowerHub Inventory, Fuel, Purchasing & Maintenance — Closure Register

**Status date:** 2026-10-22  
**Baseline:** `main` at `6f7087ad6ff8bfe3d72bce33fa0fabf556e389d7`  
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

The latest verified branch head `6bf1b51bdf382e69274d273fca22da93c9501bd1` passed PowerHub CI (TypeScript, test suite, production build), PostgreSQL integration, Supabase Admin Guard, and PowerHub Security. These are code-level gates, not a substitute for staging E2E or schema parity.

- [x] Complete item lifecycle: guarded edit/deactivate, duplicate-code handling, referenced-history preservation and audit.
- [x] Complete supplier lifecycle: edit/deactivate; address/tax fields exposed while historical finance records are preserved.
- [x] Complete warehouse/location lifecycle and model central warehouse, branch warehouse, fixed fuel tank and generator-associated tank with tenant/site-safe generator linkage.
- [x] Full stocktake workflow: session/date, counted quantity, system quantity, variance, reason, approval, posted adjustment and audit; stale submitted counts can be safely cancelled and replaced.
- [x] Durable item-level purchase units: unique per-item labels, positive six-decimal conversion factor, immutable conversion snapshot on purchase lines, no unconfigured units or client-forged factors, audited deactivate/reactivate, and guards against changing the base unit after purchase units exist. PostgreSQL integration, UI contract, TypeScript and production build gates passed on `4c1a631dd49772914dce471b0664b27e6d4decf5`.
- [x] Supplier opening payable balance with traceable date/reference/reason and balanced ledger representation.
- [x] Supplier payment batch allocated to multiple invoices/opening balances, with row locks, amount validation, idempotency, company-account movement, ledger postings and audit in one transaction.
- [ ] Explicitly support and test purchase payment intent (paid in full / partially paid / on credit) without double-debiting the company account or double-counting inventory cost. The current UI can record payments from invoice details; acceptance is the approved end-to-end user flow, not field presence.
- [x] Supplier payable aging: not-due and 1–30/31–60/61–90/91+ overdue bands and totals, scoped by tenant/site and financial-view permission.
- [ ] Complete supplier detail tabs/report/export UX where required by the nine-tab design.
- [ ] Reconcile stock quantity/value, receipt cost, return credit, supplier balance, payment allocations and company-account transactions end-to-end.
- [ ] Review fine-grained capabilities against each operation (view/create/edit/deactivate/approve/receive/pay/reverse/stocktake/report); show the effective permission result in platform administration. Current per-staff overrides intentionally exclude owner profiles in their current RPC; resolve this against the approved “each user” intent explicitly before closure.
- [x] UI-contract tests and disposable PostgreSQL integration assertions cover lifecycle, stocktake, units, opening balance, batch payments, aging, permissions, idempotency, tenant isolation and reconciliation scenarios.
- [ ] Staging E2E: create disposable fixture data; draft -> approve -> partial receipt -> additional receipt -> partial and multi-invoice payments -> supplier return/refund -> issue/return/transfer -> stocktake -> reports; reconcile totals; remove only explicitly created fixture data.
- [ ] Check staging and production migration identities/schema parity after deployment, without financial mutation of production.

**Phase A exit gate:** all checklist items above are closed or explicitly documented as a conscious product decision approved by the user; all relevant CI gates pass; no RLS/ACL/tenant/site/account leakage; stock quantity/value and supplier/account ledgers reconcile; retry/concurrency tests pass; staging UI end-to-end passes.

## Phase B — measured fuel and consumption (not yet complete)

- [ ] Model independent stock locations/tanks and source/target tank relations.
- [ ] Append-only refuelling events: generator, date/time, litres, source item/location, destination generator tank, cost, level before/after, meter hours, reference and actor.
- [ ] Append-only dated readings for tank level and hour meter; reject impossible/backwards readings except documented corrections.
- [ ] Keep purchased, received, issued/filled, and measured consumed quantities distinct.
- [ ] Compute measured consumption using documented opening stock + fills - ending stock - recorded withdrawals/returns as applicable.
- [ ] When readings are insufficient, report filled/issued quantity honestly rather than asserting actual consumption.
- [ ] Compute litres/hour from two dated, valid operating-hour readings; litres/kWh only when a reliable generator-output meter exists.
- [ ] Configurable low-level and abnormal-use alerts with idempotent dispatch.
- [ ] Reports by day, PowerHub cycle, month, generator, branch, stock location and cost.
- [ ] Server/database authorization, audit, idempotency, concurrency and integration tests.

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

## Current verified gap snapshot (2026-10-22)

- The UI currently exposes six tabs: “دليل الأصناف”, “الموردون”, “المخازن”, “الأرصدة والحركات”, “المشتريات”, “التقارير والتصدير”. Final design requires nine logical tabs.
- Stock, purchasing and supplier-payables schema/RPCs are present in both production and staging.
- Database inspection did not find dedicated maintenance-order/preventive-maintenance tables/functions, or historical generator fuel-fill/level/hour-reading tables/functions.
- Stock/purchasing/payables tables in staging were empty at inspection time. Passing disposable PostgreSQL tests does not prove that a full staging UI journey has been run.
- CSV movement export is complete and paginated; approved multi-sheet Excel and branded RTL PDF are not implemented in this module.
- Latest confirmed main baseline is `6f7087ad6ff8bfe3d72bce33fa0fabf556e389d7`; re-check main/PR state before each future implementation session.

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
