# P5 — Launch & Scale

## Objective
Make PowerHub ready to onboard and operate its first real customer with minimal developer intervention, while preserving tenant isolation, financial controls, and production safety.

## P5.1 — Product Readiness

### Current verified state
- Authenticated workspace routes are protected by `RouteAccessGate`.
- Platform administration is separated from tenant workspace access.
- Core operational routes exist for subscribers, generators, readings, invoices, collections, expenses, reports, branches, HR, payroll, attendance, mobile sync, and settings.
- Public subscriber portal is isolated from authenticated workspace routes.
- Subscription records already exist with plan, status, billing cycle, start/end dates, renewal and SMS-plan linkage.
- Tenant onboarding is currently platform-admin driven through the generator-owner registration flow; there is not yet a complete self-service customer onboarding wizard.

### Readiness gaps to address
1. Provide a guided first-run setup for a tenant owner/admin.
2. Make the setup state visible: company profile, first branch, first generator, first tariff, subscriber import, and operational readiness.
3. Prevent incomplete setup from looking like a fully configured production workspace.
4. Keep platform-admin provisioning available for assisted onboarding.
5. Ensure expired/suspended subscriptions have explicit, predictable enforcement.
6. Keep field/mobile scope limited to meter-reading capture and synchronization; payment collection is not part of the field workflow at this stage.

## P5.2 — SaaS Onboarding

Target journey:

`Create customer → activate account → first login → company/branch → generator → tariff → subscribers → first reading → first invoice → first collection`

The journey should be repeatable without database edits or developer-only commands.

## P5.3 — Subscription & Commercial Model

Required states:
- Trial
- Active
- Suspended
- Expired
- Cancelled

Plans must expose enforceable limits for subscribers, branches and user/subaccount capacity. Expiry handling must fail closed for protected operations without deleting customer data.

## P5.4 — Operational Dashboard

The customer workspace should make these KPIs immediately visible where data exists:
- revenue
- collections
- outstanding balances
- consumption
- readings
- invoices
- expenses
- collector activity
- operational alerts
- branch KPIs

## P5.5 — Production Observability

Use the P4 SLO baseline and production controls as the foundation for operational monitoring. Prioritize application errors, financial RPC failures, synchronization failures, subscription enforcement failures and tenant-isolation signals.

## P5.6 — Commercial Launch

Before first external customer:
- production smoke test
- clean demo tenant/data set
- complete onboarding rehearsal
- tenant-isolation regression test
- subscription expiry/suspension test
- first reading → invoice → collection rehearsal
- rollback candidate confirmed

## Deferred items
- Supabase backup/restore drill remains a pre-scale reliability requirement.
- Full removal of all heavy static Excel/PDF imports remains a later performance optimization unless P5 measurements show it blocks launch.
