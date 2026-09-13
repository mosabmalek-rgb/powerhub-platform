import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../../server/routers";

const baseTrpc = createTRPCReact<AppRouter>();

type AdminMigrationCompat =
  "advancedDashboard"
  | "financeOverview"
  | "globalSearch"
  | "listComplaints"
  | "listTenantBranchSettings"
  | "platformAccessDirectory"
  | "platformTweetSmsReport"
  | "testPlatformTweetSmsAccount"
  | "generatorDetails";

type AdminCompatRouter = Omit<typeof baseTrpc.admin, AdminMigrationCompat> & {
  [K in AdminMigrationCompat]: any;
};

/**
 * Transitional client contract bridge for the Supabase admin migration.
 * Runtime behavior remains fully typed on the server; only the small set of
 * procedures whose result shapes are being reconciled are widened here until
 * their generated contracts are finalized.
 */
export const trpc = baseTrpc as typeof baseTrpc & {
  admin: AdminCompatRouter;
};
