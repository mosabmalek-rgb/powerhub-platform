import { TRPCError } from "@trpc/server";
import { createClient } from "@supabase/supabase-js";
import type { Request } from "express";

export type PlatformCapability = "manageSupportChat";

function getSupabasePublicConfig() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Supabase Auth is not configured.",
    });
  }

  return { url, publishableKey };
}

/**
 * Server-side guard for platform-scoped capabilities.
 *
 * Authorization is resolved by Postgres from auth.uid(). The browser/user
 * profile is never accepted as an authority-bearing actor identifier.
 */
export async function requirePlatformCapability(
  req: Pick<Request, "headers">,
  capability: PlatformCapability,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing Supabase access token." });
  }

  const { url, publishableKey } = getSupabasePublicConfig();
  const supabase = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });

  const { data, error } = await supabase.rpc("powerhub_has_platform_capability", {
    p_capability: capability,
  });

  if (error) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "تعذر التحقق من صلاحية المنصة.",
      cause: error,
    });
  }

  if (data !== true) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "ليس لديك صلاحية الوصول إلى هذه الوظيفة.",
    });
  }
}
