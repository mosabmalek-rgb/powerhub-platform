import { router } from "./_core/trpc";
import { adminRouter as adminRuntimeRouter } from "./admin-runtime";
import { adminRouterWithSupabaseReadContracts } from "./admin-runtime-reads";

const legacyAdminRecord = adminRuntimeRouter._def.record;
const supabaseAdminRecord = adminRouterWithSupabaseReadContracts._def.record;

type LegacyAdminRouter = typeof adminRuntimeRouter;
type SupabaseAdminRouter = typeof adminRouterWithSupabaseReadContracts;
type PowerHubAdminRouter = Omit<LegacyAdminRouter, keyof SupabaseAdminRouter> & SupabaseAdminRouter;

export const adminRouter = router({
  ...legacyAdminRecord,
  ...supabaseAdminRecord,
}) as unknown as PowerHubAdminRouter;

export type AdminRouter = typeof adminRouter;
export type { LegacyAdminRouter, PowerHubAdminRouter };
export { addSubscriptionPeriod, tenantStatusForSubscription, platformSmsFallbackProviderSummary } from "./admin-runtime";
