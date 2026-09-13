import type { AdminRouter } from "./admin-runtime";
import { adminRouterWithSupabaseReadContracts } from "./admin-runtime-reads";

export const adminRouter = adminRouterWithSupabaseReadContracts as unknown as AdminRouter;
export type { AdminRouter };
export { addSubscriptionPeriod, tenantStatusForSubscription, platformSmsFallbackProviderSummary } from "./admin-runtime";
