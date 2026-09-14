import type { AdminRouter as LegacyAdminRouter } from "./admin-runtime";
import { adminRouterWithSupabaseReadContracts } from "./admin-runtime-reads";

type MigrationCompatibilityAdminRouter = Omit<LegacyAdminRouter, "advancedDashboard" | "userDirectory" | "generatorDetails" | "listTenantBranchSettings" | "listComplaints"> & {
  advancedDashboard: any;
  userDirectory: any;
  generatorDetails: any;
  listTenantBranchSettings: any;
  listComplaints: any;
};

export const adminRouter = adminRouterWithSupabaseReadContracts as unknown as MigrationCompatibilityAdminRouter;
export type AdminRouter = MigrationCompatibilityAdminRouter;
export { addSubscriptionPeriod, tenantStatusForSubscription, platformSmsFallbackProviderSummary } from "./admin-runtime";
