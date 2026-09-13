import type { AdminRouter } from "./admin-runtime";
import { adminRouterWithSupabaseReadContracts } from "./admin-runtime-reads";

type AdminSupabaseReadRouter = typeof adminRouterWithSupabaseReadContracts;
type PowerHubAdminRouter = AdminRouter & AdminSupabaseReadRouter;

export const adminRouter = adminRouterWithSupabaseReadContracts as unknown as PowerHubAdminRouter;
export type { AdminRouter, PowerHubAdminRouter };
export { addSubscriptionPeriod, tenantStatusForSubscription, platformSmsFallbackProviderSummary } from "./admin-runtime";
