# Admin Supabase Migration Status

## Scope
This branch continues the Supabase-first admin runtime migration without touching Production. Guarded legacy writes are replaced one path at a time with atomic Supabase RPCs, runtime adapters, and regression tests.

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
- Staff suspension / clear-suspension runtime bridge
- Staff/RBAC RPC contracts: custom roles, staff permissions/status, existing-staff assignment
- Company-account RPC contracts: create, movements, transfers, account settings
- WhatsApp webhook persistence and Supabase Auth/profile/invitation synchronization

Each migrated path is wired through the public tRPC procedure name and backed by a Supabase RPC or atomic Supabase write contract. Runtime tests are expected to assert that migrated paths do not fall back to Drizzle/MySQL.

## Staging reconciliation
`0089_reconcile_staff_rbac_and_company_account_rpcs` was added to the migration branch and applied to Staging only. The reconciliation is idempotent, does not alter existing table data, and restores the missing RPC contracts required by the runtime code.

Verified in Staging:
- Staff/RBAC and Company Accounts RPCs exist.
- `SECURITY DEFINER = false` for the reconciled functions.
- Execute is revoked from `public`, `anon`, and `authenticated`.
- Execute is granted to `service_role` only.
- `search_path` is fixed to `public, pg_temp` by the function definitions.

## Remaining guarded legacy writes
- `createGeneratorOwner` — legacy provisioning path; the newer `createGeneratorOwnerSubscription` is the canonical Supabase/Auth flow and should supersede the duplicate route rather than be rebuilt blindly.
- `updateComplaint` — not migrated because Staging currently has no `public.complaints` table. The schema must be designed and reconciled before implementing a write RPC.
- `server/powerhub.ts` and `server/admin.ts` still contain legacy source-level Drizzle/getDb paths; some are legacy procedures already shadowed by runtime overlays and some remain live candidates requiring procedure-by-procedure inventory.

## Security contract for migrated RPCs
- `SECURITY DEFINER` only where a transactional server-side mutation genuinely requires it; otherwise prefer `SECURITY INVOKER`.
- fixed `search_path = public, pg_temp`
- execution revoked from `public`, `anon`, and `authenticated`
- execution granted only to `service_role` for the server-side RPC contract
- actor and tenant/site scope validation inside PostgreSQL
- audit/security events committed in the same transaction where applicable

## CI / verification
- The latest GitHub status inspected for the migration head did not provide a successful GitHub Actions run to rely on.
- The available Vercel status was `failure` with `build-rate-limit`; this is not sufficient evidence of a TypeScript/build failure.
- Do not mark final acceptance green until focused tests, `pnpm check`, `pnpm test`, `pnpm build`, Vercel Preview, security audit, and focused E2E are independently verified.

## Production
No Production Supabase migration has been applied by this branch. No Production deployment or migration cutover is requested.

## Exit gate
The migration is not considered complete until runtime inventory confirms zero Production `getDb()` / Drizzle / MySQL callers, zero Production `DATABASE_URL` dependency, no `shared/types -> drizzle/schema` runtime dependency, CI regression guards are active with an empty legacy allowlist, and focused E2E verification passes before any Production cutover.
