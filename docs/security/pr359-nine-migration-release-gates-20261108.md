# PR #359 — nine-migration staged release gate (8 November 2026)

**Current decision: BLOCKED FOR LIVE APPLY.** This is a bounded source and read-only Staging evidence record, **not** an instruction to bypass the protected workflow. The user requested completion, then Staging migrations and verification, then Vercel Preview and verification, and only afterward Production. No Staging or Production SQL has been applied during this round.

## Immutable source / CI evidence

- PR #359: OPEN / DRAFT, mergeable, ahead of `main` without being behind; no merge and no force push.
- Last **code/test** SHA reviewed: `8980a40047cff138f66f0dab78f2404151362710`.
- GitHub workflow results on this exact SHA: PowerHub CI, Reading Cycle PostgreSQL Integration, PowerHub Security and Supabase Admin Guard **all SUCCESS**.
- The isolated PostgreSQL suite tests the new supplier/security ACLs, field-user quota and deterministic two-session concurrency, and a repeat-applied support-only Chat SELECT RLS policy.
- These results are not evidence of a hosted Staging apply, Vercel Preview acceptance, deployed web client, or Production readiness.

## Full proposed dependency order — one file per protected run

1. `supabase/migrations/20261107120000_powerhub_inventory_supplier_site_rls_scope.sql`
2. `supabase/migrations/20261107130000_powerhub_inventory_phase_d_supplier_allocation_scope.sql`
3. `supabase/migrations/20261107130443_powerhub_platform_support_identity_role_guard.sql`
4. `supabase/migrations/20261107140000_powerhub_inventory_supplier_payables_allocation_scope.sql`
5. `supabase/migrations/20261107143819_powerhub_company_account_capability_search_path.sql`
6. `supabase/migrations/20261107150000_powerhub_supplier_browser_read_acl_revoke.sql`
7. `supabase/migrations/20261107150951_powerhub_public_default_privilege_hardening.sql`
8. `supabase/migrations/20261108111500_powerhub_field_user_policy_guard_update_and_concurrency.sql`
9. `supabase/migrations/20261108120000_powerhub_chat_message_support_scope_read_hardening.sql`

The last two are **new forward-only corrections**. Never reapply historical field-user or Chat migrations simply to align versions. The Chat source change addresses a broader `manageSupportChat` SELECT arm observed in Production, while Staging already had support-scoped rules. The field-user source change fixes an at-quota existing technician update and adds tenant-serialized admissions.

## Live Staging read-only checks completed

A fresh combined catalog preflight on Staging confirmed:

- `private.powerhub_has_site_access(bigint,bigint)` exists.
- All 10 supplier tables exist with RLS enabled and service-role SELECT. Eight still have authenticated SELECT and therefore the **relative ordering of steps 1 and 6 is mandatory**.
- Platform identity dependencies and four expected user identity/role/status columns are present.
- The company-account helper is a postgres-owned SECURITY DEFINER.
- Field-user guard and feature-policy resolver dependencies exist; active field-users catalog and five package policies were independently observed.
- Chat helper dependencies, RLS and the expected SELECT policy exist.
- No postgres-owned functions or function-default entries were returned in either of the checked unreviewed-schema categories for the default-ACL migration.
- `pg_cron` and `pg_net` extension metadata were read; both were owned by `supabase_admin`. No Cron jobs, Vault secrets or live business rows were accessed.
- **All nine target migration versions remain unregistered in Staging and Production** in the latest read-only ledger check.

These are prerequisite observations, not a comprehensive nine-file behavioral preflight or a promise that an application transaction will succeed.

## Blocking conditions that must be resolved before any Staging apply

1. The 28-name historical migration crosswalk has archival SQL text comparisons, but **only two** cases have verified Staging implementation/catalog postconditions and 26 remain not formally reconciled at the object/behavior level. Historic version mismatches must not be repaired by replaying old SQL or editing `schema_migrations`.
2. Twelve Staging migration rows have empty SQL payloads; present tables, functions and indices do not prove the exact historical execution sequence. Three separate Production rows have empty SQL payloads. See `pr359-empty-migration-statements-audit-20261108.md`.
3. Verify real deployed supplier readers, PostgREST schema exposure and server capability resolution with isolated credentials/test identities before revoking browser supplier reads. No financial transactions, actual SMS, user device takeovers or destructive database operations.
4. Obtain protected GitHub environment review for the specific approved migration path, source SHA and target. `.github/workflows/supabase-migration-release.yml` requires `main` workflow dispatch, an approved `supabase-staging` environment, one migration at a time, and `source_pr_number=359` for a Staging-only PR source. The available connected GitHub action set does **not** expose workflow dispatch; it must not be bypassed using Supabase `apply_migration`, which generates noncanonical execution-time versions.
5. Recheck current source/head, same-SHA CI, ledger versions and live preflight just before release. A failure or unknown commit outcome blocks subsequent steps; use read-only ledger/catalog verification, never blind reapplication.

## After protected Staging approval/application

- Apply only step 1, read back version/name/stored SQL and target catalog postconditions; continue one at a time through step 9 only after passing checks. Do not rerun step 1 after step 6 because the ACL preflight expectations intentionally change.
- Run synthetic tenant/site/browser denial and server-only RPC acceptance; verify field-user at-limit update, concurrency, enabled/disabled tenant feature policy, Chat public/internal/support scope, Offline/Delta and payment-read safety.
- Only after Staging passes, create **one** protected Vercel Preview from the pinned PR SHA; independently confirm Preview backend project identity is Staging, not Production, before login, API, UI and offline E2E acceptance.
- Production release requires the same explicit safety review, verified backups/recovery procedure, separate production environment approval and immutable SQL source from `main`. Current protected workflow disallows `source_pr_number` on Production; because PR #359 is DRAFT and not approved for merge, Production application is **not currently executable through that workflow**. Never merge to bypass this gate.

## Status

**Done:** source corrections, isolated PostgreSQL tests, fresh read-only Staging checks, same-SHA green CI for source/test SHA.

**Not done:** historical object/behavior reconciliation, deployed-client acceptance, human environment approval, Staging apply, Staging E2E acceptance, Vercel Preview deployment, Preview acceptance, Production promotion/apply.

**Safety:** no Staging/Production database writes, migration-history changes, merge, force push, new Preview, real SMS/payment activity or device-lock transfer in this round.
