import { ForbiddenError } from "@shared/_core/errors";
import { createClient } from "@supabase/supabase-js";
import type { Request } from "express";
import { syncSupabaseProfile, type SupabaseProfileUser } from "../supabase-profile";

function getSupabasePublicConfig() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw ForbiddenError("Supabase Auth is not configured");
  }

  return { url, publishableKey };
}

/**
 * Verifies a browser Supabase access token and keeps its application profile in
 * sync. This deliberately has no dependency on the legacy OAuth/session SDK.
 */
export async function authenticateSupabaseRequest(req: Pick<Request, "headers">): Promise<SupabaseProfileUser> {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    throw ForbiddenError("Missing Supabase access token");
  }

  const { url, publishableKey } = getSupabasePublicConfig();
  const supabase = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser(authHeader.slice(7));

  if (error || !data.user?.email) {
    throw ForbiddenError("Invalid Supabase access token");
  }

  return syncSupabaseProfile({
    id: data.user.id,
    email: data.user.email,
    name: (data.user.user_metadata?.name as string | undefined) ?? data.user.email.split("@")[0],
  });
}
