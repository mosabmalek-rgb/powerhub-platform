# P5.4 — Operational Dashboard

## Purpose

P5.4 upgrades the tenant workspace dashboard into an operational decision center while reusing the existing PowerHub APIs and financial data model.

## P5.4.1 Baseline audit

### Existing dashboard already provides

- Branch/all-branches scope selector for users allowed to view aggregated branches.
- Monthly invoicing, collections, collection rate, outstanding balances, and active subscribers.
- Today collection pulse and monthly net cash.
- Overdue balances, partial invoices, open accounts, and top debtors.
- Branch performance summaries when the all-branches scope is selected.
- Generator/subscriber operational status.
- Subscriber quota, branch quota, company account balances, and owner SMS quota/alerts.
- Quick actions for subscribers, invoices, collections, and reports.

The existing `financialOverview` backend aggregates invoices, completed payments, expenses, branch summaries, and top debtors. Its source utility is `server/financial-overview-utils.ts` and is already separated from the page presentation layer.

## Identified P5.4 gaps

1. **Unified time filter:** the current home dashboard is effectively today/month oriented. P5.4 should support Today, 7 days, 30 days, current month, and custom period without creating separate calculation paths.
2. **Consumption KPI:** kWh and reading completion metrics are not yet part of the main operational summary.
3. **Reading workflow health:** pending/approved/exception counts should be surfaced as an operational signal.
4. **Collector performance:** collection activity should be summarized by collector using the existing collector/payment data.
5. **Actionable alerts:** operational and financial alerts should be normalized into a compact priority list with direct navigation targets.
6. **System health:** the tenant workspace needs a lightweight status indicator for sync/notifications/critical operational failures, without turning the tenant dashboard into the platform-admin monitoring console.

## Architecture decision

Do **not** create a second dashboard page that duplicates the existing workspace home. P5.4 will evolve `Home.tsx` and the dashboard server procedures, preserving existing route behavior and RBAC.

Prefer one server-side aggregate for dashboard-specific operational metrics. The aggregate must:

- accept a validated site/scope and time range;
- enforce tenant/site authorization before querying data;
- use the existing Supabase-backed tables/procedures;
- return normalized numeric values and ISO timestamps;
- avoid exposing credentials, internal error details, or cross-tenant identifiers;
- remain read-only.

## Delivery sequence

- **P5.4.1** Baseline audit — complete with this document.
- **P5.4.2** Unified period filter + financial trend series.
- **P5.4.3** Consumption and meter-reading KPIs.
- **P5.4.4** Collector performance and operational alerts.
- **P5.4.5** Dashboard UX/performance and responsive review.
- **P5.4.6** Automated tests, production build, PR review, and production verification.

## Scope boundary

The field/mobile workflow remains focused on meter-reading capture and synchronization. Payment/collection workflows remain in the workspace and are not added to the field app in P5.4.
