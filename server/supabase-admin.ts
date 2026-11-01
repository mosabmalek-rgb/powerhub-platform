import { createClient } from "@supabase/supabase-js";

type SupabaseAdminUrlEnvironment = {
  VERCEL_ENV?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
};

function getProjectOrigin(value: string, variableName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${variableName} is not a valid Supabase project URL.`);
  }

  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.hostname) {
    throw new Error(`${variableName} is not a valid Supabase project URL.`);
  }
  return parsed.origin;
}

/**
 * Resolve the server's privileged Supabase project without silently inheriting
 * the browser's VITE URL in a deployed Preview environment.
 *
 * Vercel Preview must explicitly configure both URLs and keep them on the same
 * project. Local development may still fall back to VITE_SUPABASE_URL.
 */
export function resolveSupabaseAdminProjectUrl(
  env: SupabaseAdminUrlEnvironment = process.env,
): string {
  const serverUrl = env.SUPABASE_URL?.trim();
  const clientUrl = env.VITE_SUPABASE_URL?.trim();
  const isVercelPreview = env.VERCEL_ENV === "preview";

  if (isVercelPreview && (!serverUrl || !clientUrl)) {
    throw new Error("Both server and client Supabase URLs must be explicitly configured for Preview deployments.");
  }

  if (serverUrl && clientUrl) {
    const serverOrigin = getProjectOrigin(serverUrl, "SUPABASE_URL");
    const clientOrigin = getProjectOrigin(clientUrl, "VITE_SUPABASE_URL");
    if (serverOrigin !== clientOrigin) {
      throw new Error("Server and client Supabase URLs must target the same project.");
    }
  }

  const projectUrl = serverUrl ?? (isVercelPreview ? undefined : clientUrl);
  if (!projectUrl) {
    throw new Error("Supabase server project URL is not configured.");
  }
  getProjectOrigin(projectUrl, "SUPABASE_URL");
  return projectUrl;
}

export function supabaseAdmin() {
  const projectUrl = resolveSupabaseAdminProjectUrl();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) throw new Error("Supabase administrative credentials are not configured.");
  return createClient(projectUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
