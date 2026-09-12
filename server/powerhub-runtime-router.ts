import { router } from "./_core/trpc";
import { powerhubRouter } from "./powerhub";
import { powerhubMobileSyncSupabaseRouter } from "./powerhub-mobile-sync-supabase-router";

/**
 * Runtime overlay used during the Supabase migration.
 * It preserves the existing PowerHub API/type surface while replacing only
 * the mobileSync subtree with the Supabase-native implementation.
 *
 * The legacy router remains guarded so direct legacy callers cannot execute
 * the old MySQL approval path.
 */
export const powerhubRuntimeRouter = (router({
  ...((powerhubRouter as any)._def.record as Record<string, unknown>),
  mobileSync: powerhubMobileSyncSupabaseRouter,
}) as unknown) as typeof powerhubRouter;
