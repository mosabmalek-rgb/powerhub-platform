import { router } from "./_core/trpc";
import { powerhubRouter } from "./powerhub";
import { approveAndIssueMobileReadingRuntime } from "./powerhub-mobile-approve-runtime";

const legacyRecord = (powerhubRouter as any)._def.record as Record<string, any>;
const legacyMobileSync = legacyRecord.mobileSync as any;

/**
 * Runtime overlay used during the Supabase migration. Only the individual
 * mobile approval mutation is replaced; the remaining mobile-sync procedures
 * continue to use their existing Supabase-backed implementations.
 */
export const powerhubRuntimeRouter = router({
  ...legacyRecord,
  mobileSync: router({
    ...legacyMobileSync._def.record,
    approveAndIssue: approveAndIssueMobileReadingRuntime,
  }),
});
