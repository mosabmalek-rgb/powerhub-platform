import { adminRouterWithSupabaseReadContracts } from "./admin-runtime-reads";

export const adminRouter = adminRouterWithSupabaseReadContracts;
export type AdminRouter = typeof adminRouter;
export { addSubscriptionPeriod, tenantStatusForSubscription, platformSmsFallbackProviderSummary } from "./admin-runtime";
