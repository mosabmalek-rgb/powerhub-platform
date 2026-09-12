# Admin Supabase Migration Status

## Scope
This branch continues the Supabase-first admin runtime migration without touching Production. Guarded legacy writes are replaced one path at a time with atomic Supabase RPCs, runtime adapters, and regression tests.

## Migrated admin write paths
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

Each migrated path is wired through the public tRPC procedure name and backed by a Supabase RPC or atomic Supabase write contract. Runtime tests assert that the migrated path does not fall back to Drizzle/MySQL.

## Remaining guarded legacy writes
- `createGeneratorOwner` — legacy provisioning path; the newer `createGeneratorOwnerSubscription` is the canonical Supabase/Auth flow and should supersede the duplicate route rather than be rebuilt blindly.
- `updateComplaint` — not migrated because Staging currently has no `public.complaints` table. The schema must be designed and reconciled before implementing a write RPC.

## Security contract for migrated RPCs
- `SECURITY DEFINER` where transactional server-side mutation is required
- fixed `search_path = public, pg_temp`
- execution revoked from `public`, `anon`, and `authenticated`
- execution granted only to `service_role`
- actor validation inside PostgreSQL
- audit/security events committed in the same transaction where applicable

## CI / verification
The Security workflow passes on the migration branch. The current CI blocker is an unrelated pre-existing TypeScript error in `client/src/pages/NetworkDirectoryPage.tsx` (`user` possibly null); it is outside the migration diff and is intentionally not hidden by changing compiler strictness.

## Production
No Production Supabase migration has been applied by this branch. No Production deployment is requested.

## Exit gate
The migration is not considered complete until runtime inventory confirms zero Production `getDb()` / Drizzle / MySQL callers, zero Production `DATABASE_URL` dependency, no `shared/types -> drizzle/schema` runtime dependency, CI regression guards are active, and focused E2E verification passes before any Production cutover.
