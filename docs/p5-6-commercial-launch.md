# P5.6 — Commercial Launch Gate

## هدف المرحلة

إثبات أن PowerHub صالح لبدء أول تشغيل تجاري مع عميل خارجي، مع الحفاظ على عزل المستأجرين، الضوابط المالية، وسلامة الإنتاج.

## Release gate

### 1. Production smoke test

Run:

```bash
pnpm test:launch
```

The smoke gate verifies that the production domain serves the public application shell on `/`, `/login`, `/portal`, and `/404`, and that the primary module asset is reachable.

The URL can be overridden for a preview or controlled environment:

```bash
POWERHUB_PRODUCTION_URL=https://example.vercel.app pnpm test:launch
```

### 2. Clean demo tenant

Use a dedicated demo tenant that contains only synthetic data. Do not use a real customer's records for rehearsals or automated tests.

Minimum demo dataset:

- one tenant
- one branch/site
- one generator
- one active tariff
- a small subscriber set
- meter readings across at least two billing periods
- invoices generated from approved readings
- at least one successful collection
- representative operating expense data

### 3. Onboarding rehearsal

Rehearse the complete customer journey without direct database edits:

`Create customer → activate account → first login → company/branch → generator → tariff → subscribers → first reading → first invoice → first collection`

Record any step that requires developer-only intervention as a launch blocker until an approved assisted-onboarding procedure exists.

### 4. Tenant-isolation regression

Verify with two independent tenant identities that:

- tenant A cannot read tenant B records
- tenant A cannot mutate tenant B records
- site-scoped operations cannot escape the selected site
- platform-admin-only routes reject tenant users
- public subscriber/invoice links do not disclose unrelated tenant data

Prefer existing RLS/RBAC integration tests plus a controlled production-safe verification using synthetic tenants.

### 5. Subscription enforcement

Verify each state required by the commercial model:

- Trial
- Active
- Suspended
- Expired
- Cancelled

Confirm that protected operations fail closed when a subscription is not entitled to use them, while customer data remains intact.

Trial-duration changes and subscription lifecycle operations must continue to use the existing protected server procedures.

### 6. Financial rehearsal

Execute the business-critical flow on synthetic data:

`approved meter reading → invoice → collection → balance/reporting`

Check that invoice totals, payment amount, outstanding balance, and dashboard/report values remain consistent.

### 7. Rollback candidate

Before announcing launch, identify one previously verified production deployment that can be promoted or rolled back to immediately if the release exhibits a critical regression.

## Observability gate

Review the current production deployment and recent runtime errors before launch. A release is not considered clean when there are unexplained production exceptions, authentication failures, financial RPC errors, synchronization failures, or tenant-isolation alerts.

## Current known advisories

Supabase currently reports one security warning for leaked password protection being disabled and an informational RLS notice for `subscriber_portal_attempts` having RLS enabled without policies. These must be reviewed as part of the launch security sign-off; the RLS notice should remain intentionally closed only if the table is deliberately write-only through privileged procedures and direct row access is not required.

Supabase also reports informational performance findings for several unindexed foreign keys and unused indexes. These are not automatically launch blockers; address them based on measured query paths rather than adding speculative indexes.

## CI verification note

The launch branch intentionally does not alter dependency versions. The committed `pnpm-lock.yaml` remains the source of truth for the existing dependency graph; CI must continue to use `pnpm install --frozen-lockfile`.

## Deferred reliability work

The Supabase backup/restore drill remains a pre-scale reliability requirement. Full removal of heavy static Excel/PDF import paths remains a later performance optimization unless measured production usage shows launch impact.
