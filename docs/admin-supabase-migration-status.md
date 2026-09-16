# Admin Supabase Migration Status

## Scope
This document records the current Supabase-first migration state of the PowerHub production runtime. Production has received targeted reconciliation migrations where the live schema/RPC contract was missing or drifted from the repository history.

## Migrated admin/runtime paths
- `setTenantMembershipStatus`
- `attachOwnerUser`
- `updateSubscription`
- `reviewSubscriptionUpgradeRequest`
- `quickUpgradeOwnerPlan`
- `renewSubscription`
- `reviewSmsPackageRequest`
- `invitePlatformAccess`
- `setPlatformAccountStatus`
- `setPlatformAccessRole`
- `createTariffPolicy`
- `savePlatformSetting`
- `requestOwnerAccessRecovery`
- `saveRolePolicy`
- `inviteTenantAccess`
- `createSmsPlan`
- `updateSmsPlan`
- `saveTenantBranchSettings`

The Production database currently exposes the 18 admin RPC contracts above with `SECURITY DEFINER`, `EXECUTE` granted to `service_role`, and `EXECUTE` revoked from `public`, `anon`, and `authenticated`.

## Production reconciliation state
The following reconciliation migrations were applied directly to Production on 2026-09-16 because the corresponding runtime RPC contracts were missing or incomplete in the live database:

- `reconcile_admin_membership_subscription_rpcs`
- `reconcile_admin_platform_runtime_rpcs_20260912`
- `reconcile_admin_settings_rpcs`
- `reconcile_platform_access_and_sms_rpcs`
- `reconcile_owner_access_rpcs`
- `reconcile_admin_policy_rpcs`
- `fix_tariff_policy_notification_contract`
- `harden_public_powerhub_function_exec`

These changes are being brought back under repository source control. The last item is now represented by:
`supabase/migrations/20260916180420_harden_public_powerhub_function_exec.sql`.

The remaining reconciliation SQL must be captured/verified against the existing repository migrations before the migration history is declared synchronized.

## Migration-history drift
Production migration history and repository migration filenames are not yet a one-to-one match. This is intentional during reconciliation and must not be “fixed” by blindly applying old migrations.

Example: repository migration `0084_powerhub_admin_branch_settings.sql` contains the same `powerhub_admin_save_tenant_branch_settings` contract currently present in Production, but Production history records the function through a later reconciliation migration rather than version `0084`. The live function definition was compared with the repository definition and is semantically aligned.

Where the live schema already matches the repository migration, the remaining operation is migration-history reconciliation using the Supabase migration tooling; do not modify `supabase_migrations.schema_migrations` directly from application SQL.

## Security hardening
A production privilege audit found four helper functions that were executable by `public`/`anon`/`authenticated` even though they are server-side/internal operations:

- `powerhub_apply_trial_duration()`
- `powerhub_apply_trial_duration_8_days()`
- `powerhub_ensure_owner_main_site()`
- `powerhub_subscriber_reference_immutable()`

Execution is now revoked from `public`, `anon`, and `authenticated` and retained for `service_role` only. The change is source-controlled as migration `20260916180420_harden_public_powerhub_function_exec.sql`.

## Staging reconciliation
`0089_reconcile_staff_rbac_and_company_account_rpcs` remains a Staging reconciliation migration. Its contracts are expected to remain service-role-only where they are server-side mutation paths.

## Remaining guarded legacy writes
- `createGeneratorOwner` — legacy provisioning path; `createGeneratorOwnerSubscription` remains the canonical Supabase/Auth flow.
- `updateComplaint` — not migrated because the required `public.complaints` schema contract is not established.
- `server/powerhub.ts` and `server/admin.ts` still require procedure-by-procedure legacy access inventory; the existence of old imports is not by itself proof of a live Production dependency.

## CI / verification
GitHub Actions quota/startup failures previously observed are infrastructure/quota failures, not evidence of application-code failure. They must be rerun after quota availability returns.

Final acceptance still requires independent verification of:
- focused Supabase runtime tests
- `pnpm check`
- `pnpm test`
- `pnpm build`
- Vercel Preview/deployment health
- security audit
- focused E2E
- complete repository-vs-Production migration reconciliation

## Exit gate
The migration is not considered complete until the repository migration history is reconciled with Production, all live Supabase RPC contracts are source-controlled, runtime inventory confirms no unintended Production Drizzle/MySQL/DATABASE_URL dependency, security grants are least-privilege, and focused end-to-end verification passes.
