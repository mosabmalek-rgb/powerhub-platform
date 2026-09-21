# PowerHub Production Migration Reconciliation — 2026-09-21

## Purpose

This document records the verified relationship between the current Git migration tree and the live Production migration ledger.

The Production database is **not** a replayable copy of the current repository migration directory. The repository contains a consolidated/canonical migration tree, while Production contains a longer historical ledger with many migrations that are not present as files in the current branch.

## Verified counts

- Production migration records: **237**
- SQL migration files in the current release branch: **163**
- Timestamp-prefixed migration files in the current release branch: **86**
- Exact timestamp-version overlap between Production and the current repository: **5**

The five exact timestamp overlaps are:

| Version | Production | Repository |
|---|---|---|
| 20260914070201 | admin_subscription_upgrade_enrichment_rpc | matching file |
| 20260914070229 | harden_admin_subscription_upgrade_enrichment_rpc_execute | matching file |
| 20260916180420 | harden_public_powerhub_function_exec | matching file |
| 20260917200351 | harden_powerhub_advisory_lock_signatures | matching file |
| 20260920114622 | powerhub_staff_permissions_deny_all_fix | matching file |

This low overlap is expected from the current consolidated migration layout and is **not evidence that Production is missing 232 schema changes**.

## Verified recent reconciliation status

The following repository migrations are not recorded in the live Production migration ledger, but their intended schema/runtime effects were verified directly in Production:

### Applied but untracked

- 20260920133000 — payment documentation approval capability
- 20260920134000 — custom RBAC extension for approval capability
- 20260920143000 — payment documentation financial uniqueness
- 20260920145000 — payment documentation financial hardening
- 20260920150000 — payment documentation reject-lock parity
- 20260920170000 — platform announcements v1
- 20260920180000 — platform announcements scheduler
- 20260920190000 — subscriber portal identity policy
- 20260920200000 — payment receipt retention

Production verification included the relevant capability constraint, RPC signatures/grants, unique financial indexes, announcement tables/indexes, RLS state, cron job, retention columns, and receipt-retention index.

## Actual drift

### 20260920213000 — payment documentation feature entitlement

This migration is **partially represented in Production**.

Verified present in Production:

- global `payment_documentation` platform setting is enabled;
- package catalog contains `paymentDocumentationPolicy: addon`;
- `powerhub_payment_documentation_access(bigint)` exists and is service-role-only;
- `powerhub_owner_set_payment_documentation(bigint,bigint,boolean)` exists and is service-role-only;
- no entitlement rows currently exist in `tenant_feature_entitlements`.

Verified drift:

- current Production CHECK constraint still allows only `subscriber_portal_logo`;
- runtime code also writes `payment_documentation` entitlements.

Therefore this is a real schema drift and the only confirmed blocking mismatch in this reconciliation slice.

## Safe remediation

The release branch contains:

`supabase/migrations/20260921170000_powerhub_reconcile_feature_entitlements.sql`

Its contract is intentionally narrow:

- reject unexpected feature keys;
- remove only the obsolete single-feature CHECK constraint;
- add the two-feature contract;
- preserve RLS;
- revoke direct table access from public/anon/authenticated;
- keep service-role access;
- do not recreate payment RPCs;
- do not backfill entitlement data.

The migration was dry-run inside a transaction with rollback against Production and did not modify Production.

## Prohibited action

Do **not** run `supabase db push` against Production from this release branch.

Do **not** replay the 232 Production-only migration records.

Do **not** attempt to reconstruct Production migration history by renaming or copying old migration files.

The safe model is:

**Production schema state → verified object-level reconciliation → minimal idempotent repair migrations → controlled application.**

## Release verification status

Current release branch HEAD:

`f167090f44512bec115610a6bc48f57306219822`

Vercel latest READY deployment still points to:

`8d7cf9cd3a57c0592233ae3dcbd85131c82f79d9`

The current HEAD has a Vercel status failure caused by the account's Vercel build-rate-limit path, not by a reported application build error. The last READY deployment remains the previously verified release candidate.

## Remaining controlled action

Before Production schema modification:

1. keep the reconciliation migration in Git;
2. restore a usable Vercel build slot and verify the current HEAD if a deployment is required;
3. apply only the reconciliation migration through the controlled Supabase migration path;
4. re-check the constraint, table grants, Security Advisor, and application readiness;
5. record the resulting Production state as the new baseline.

No Production migration was applied as part of this document.