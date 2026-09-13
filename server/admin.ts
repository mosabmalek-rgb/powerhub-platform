import { router } from "./_core/trpc";
import { adminRouterWithSupabaseReadContracts } from "./admin-runtime-reads";

/**
 * Runtime contract bridge during the Supabase migration.
 * The underlying router keeps the real procedure implementations; the record
 * is typed generically here so transitional legacy-compatible procedures do not
 * leak incomplete inferred result shapes into the client contract.
 */
const adminRecord = (adminRouterWithSupabaseReadContracts as any)._def.record as Record<string, any>;

export const adminRouter = router(adminRecord);
export type AdminRouter = typeof adminRouter;
export { addSubscriptionPeriod, tenantStatusForSubscription, platformSmsFallbackProviderSummary } from "./admin-runtime";
