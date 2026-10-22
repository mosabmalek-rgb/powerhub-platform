import { router } from "./_core/trpc";
import { powerhubRouter } from "./powerhub";
import { approveAndIssueMobileReadingRuntime } from "./powerhub-mobile-approve-runtime";
import { powerhubStaffSuspensionRuntimeRouter } from "./powerhub-staff-suspension-runtime";
import { powerhubUnifiedMessagingRouter } from "./powerhub-unified-messaging";
import { powerhubInventoryRouter } from "./powerhub-inventory-router";
import { powerhubMaintenanceRouter } from "./powerhub-maintenance-router";

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
// Nested routers are represented as plain records by tRPC v11. Do not look
// only for `_def.record`, otherwise the complete staff API disappears from
// the runtime bridge and callers receive NOT_FOUND for powerhub.staff.*.
const legacyStaffRecord = legacyStaff?._def?.record ?? legacyStaff;

type ReplaceRouterRecord<T extends { _def: { record: unknown } }, R> = Omit<T, "_def"> & {
  _def: Omit<T["_def"], "record"> & { record: R };
};
type PowerhubRuntimeRecord = typeof powerhubRouter["_def"]["record"] & {
  unifiedMessaging: typeof powerhubUnifiedMessagingRouter;
  inventory: typeof powerhubInventoryRouter;
  maintenance: typeof powerhubMaintenanceRouter;
};
type PowerhubRuntimeRouter = ReplaceRouterRecord<typeof powerhubRouter, PowerhubRuntimeRecord>;

export const powerhubRuntimeRouter = router({
  ...legacyRecord,
  ...(legacyMobileSync?._def?.record
    ? {
        mobileSync: router({
          ...legacyMobileSync._def.record,
          approveAndIssue: approveAndIssueMobileReadingRuntime,
        }),
      }
    : {}),
  ...((legacyStaffRecord || powerhubStaffSuspensionRuntimeRouter?._def?.record)
    ? {
        staff: router({
          ...(legacyStaffRecord ?? {}),
          suspend: powerhubStaffSuspensionRuntimeRouter._def.record.suspend,
          clearSuspension: powerhubStaffSuspensionRuntimeRouter._def.record.clearSuspension,
        }),
      }
    : {}),
  unifiedMessaging: powerhubUnifiedMessagingRouter,
  inventory: powerhubInventoryRouter,
  maintenance: powerhubMaintenanceRouter,
  readingCycle: legacyRecord.readingCycle,
}) as unknown as PowerhubRuntimeRouter;
