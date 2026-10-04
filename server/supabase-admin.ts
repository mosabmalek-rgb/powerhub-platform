import { createClient } from "@supabase/supabase-js";

export function supabaseAdmin() {
  // VITE_SUPABASE_URL is the verified Production project URL.
  // Prefer it over SUPABASE_URL so a stale/incorrect secret cannot silently
  // send server-side AI calls to a different Supabase project.
  const projectUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!projectUrl || !serviceRoleKey) throw new Error("Supabase administrative credentials are not configured.");
  return createClient(projectUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
