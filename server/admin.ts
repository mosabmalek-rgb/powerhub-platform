import type { AdminRouter as LegacyAdminRouter } from "./admin-runtime";
import { adminRouterWithSupabaseReadContracts } from "./admin-runtime-reads";

type AdminSupabaseReadRouter = typeof adminRouterWithSupabaseReadContracts;
type PowerHubAdminRouter = Omit<LegacyAdminRouter, keyof AdminSupabaseReadRouter> & AdminSupabaseReadRouter;

export const adminRouter = adminRouterWithSupabaseReadContracts as unknown as PowerHubAdminRouter;
export type AdminRouter = PowerHubAdminRouter;
export type { LegacyAdminRouter, PowerHubAdminRouter };
export { addSubscriptionPeriod, tenantStatusForSubscription, platformSmsFallbackProviderSummary } from "./admin-runtime";
