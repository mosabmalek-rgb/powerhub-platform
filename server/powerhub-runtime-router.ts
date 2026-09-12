import { router } from "./_core/trpc";
import { powerhubRouter } from "./powerhub";
import { powerhubMobileSyncSupabaseRouter } from "./powerhub-mobile-sync-supabase-router";

/**
 * Runtime overlay used during the Supabase migration.
 * It keeps the existing PowerHub API surface while replacing only the
 * mobileSync subtree with the Supabase-native implementation.
 *
 * The underlying legacy router remains guarded so direct legacy callers
 * cannot accidentally execute the old MySQL approval path.
 */
export const powerhubRuntimeRouter = router({
  ...(powerhubRouter as any)._def.record,
  mobileSync: powerhubMobileSyncSupabaseRouter,
});
