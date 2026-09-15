import { router, platformSupportProcedure } from "./_core/trpc";

/**
 * Platform Support Center procedures are intentionally separate from tenant
 * RBAC and the legacy admin role. Every procedure in this router passes the
 * manageSupportChat capability resolver backed by Supabase Auth identity.
 */
export const supportRouter = router({
  assertAccess: platformSupportProcedure.query(() => ({ allowed: true as const })),
});
