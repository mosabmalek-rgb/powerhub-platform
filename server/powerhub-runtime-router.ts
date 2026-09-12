import { router } from "./_core/trpc";
import { powerhubRouter } from "./powerhub";
import { approveAndIssueMobileReadingRuntime } from "./powerhub-mobile-approve-runtime";
import { powerhubStaffSuspensionRuntimeRouter } from "./powerhub-staff-suspension-runtime";

/**
 * Runtime bridge for the incremental Supabase migration.
 *
 * Keep the complete PowerHub API/type surface from the legacy router and
 * replace migrated procedures with Supabase-backed implementations without
 * changing their public tRPC contract.
 */
const legacyRecord = (powerhubRouter as any)._def.record as Record<string, any>;
const legacyMobileSync = legacyRecord.mobileSync as any;
const legacyStaff = legacyRecord.staff as any;

export const powerhubRuntimeRouter: typeof powerhubRouter = router({
  ...legacyRecord,
  mobileSync: router({
    ...legacyMobileSync._def.record,
    approveAndIssue: approveAndIssueMobileReadingRuntime,
  }),
  staff: router({
    ...legacyStaff._def.record,
    suspend: powerhubStaffSuspensionRuntimeRouter._def.record.suspend,
    clearSuspension: powerhubStaffSuspensionRuntimeRouter._def.record.clearSuspension,
  }),
}) as unknown as typeof powerhubRouter;
