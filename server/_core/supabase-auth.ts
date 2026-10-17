import { ForbiddenError } from "@shared/_core/errors";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Request } from "express";
import { syncSupabaseProfile, type SupabaseProfileUser } from "../supabase-profile";

let cachedAuthClient: { url: string; publishableKey: string; client: SupabaseClient<any, "public", "public", any, any> } | null = null;

function getSupabaseAuthClient(url: string, publishableKey: string) {
  if (cachedAuthClient?.url === url && cachedAuthClient.publishableKey === publishableKey) {
    return cachedAuthClient.client;
  }
  const client = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  cachedAuthClient = { url, publishableKey, client };
  return client;
}

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
  const startedAt = performance.now();
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    throw ForbiddenError("Missing Supabase access token");
  }

  const { url, publishableKey } = getSupabasePublicConfig();
  const supabase = getSupabaseAuthClient(url, publishableKey);
  const authStartedAt = performance.now();
  const { data, error } = await supabase.auth.getUser(authHeader.slice(7));
  const authMs = Math.round(performance.now() - authStartedAt);

  if (error || !data.user?.email) {
    if (authMs >= 500) console.warn("[PowerHub auth latency]", { stage: "supabase.getUser", durationMs: authMs });
    throw ForbiddenError("Invalid Supabase access token");
  }

  const profileStartedAt = performance.now();
  const user = await syncSupabaseProfile({
    id: data.user.id,
    email: data.user.email,
    name: (data.user.user_metadata?.name as string | undefined) ?? data.user.email.split("@")[0],
  });
  const profileMs = Math.round(performance.now() - profileStartedAt);
  const totalMs = Math.round(performance.now() - startedAt);

  // No user identifiers, tokens, headers, or profile values are logged.
  if (totalMs >= 800) {
    console.warn("[PowerHub auth latency]", {
      stage: "authenticateSupabaseRequest",
      authMs,
      profileSyncMs: profileMs,
      totalMs,
    });
  }
  return user;
}
