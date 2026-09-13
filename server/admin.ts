import { router } from "./_core/trpc";
import { adminRouter as adminRuntimeRouter } from "./admin-runtime";
import { adminRouterWithSupabaseReadContracts } from "./admin-runtime-reads";

const legacyAdminRecord = adminRuntimeRouter._def.record;
const supabaseAdminRecord = adminRouterWithSupabaseReadContracts._def.record;

export const adminRouter = router({
  ...legacyAdminRecord,
  ...supabaseAdminRecord,
});

export type AdminRouter = typeof adminRouter;
export type LegacyAdminRouter = typeof adminRuntimeRouter;
export { addSubscriptionPeriod, tenantStatusForSubscription, platformSmsFallbackProviderSummary } from "./admin-runtime";
