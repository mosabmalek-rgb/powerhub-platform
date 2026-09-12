import { router } from "./_core/trpc";
import { powerhubRouter } from "./powerhub";
import { approveAndIssueMobileReadingRuntime } from "./powerhub-mobile-approve-runtime";

/**
 * Runtime bridge for the incremental Supabase migration.
 *
 * Keep the complete PowerHub API/type surface from the legacy router and
 * replace only the mobileSync.approveAndIssue procedure with the atomic
 * Supabase implementation. All other mobile-sync procedures retain their
 * existing runtime implementations until they are migrated individually.
 */
const legacyRecord = (powerhubRouter as any)._def.record as Record<string, any>;
const legacyMobileSync = legacyRecord.mobileSync as any;
const legacyMobileSyncRecord = legacyMobileSync?._def?.record ?? {};

export const powerhubRuntimeRouter: typeof powerhubRouter = router({
  ...legacyRecord,
  mobileSync: router({
    ...legacyMobileSyncRecord,
    approveAndIssue: approveAndIssueMobileReadingRuntime,
  }),
}) as unknown as typeof powerhubRouter;
