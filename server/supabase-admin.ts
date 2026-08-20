import { createClient } from "@supabase/supabase-js";

export function supabaseAdmin() {
  const projectUrl = process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!projectUrl || !serviceRoleKey) throw new Error("Supabase administrative credentials are not configured.");
  return createClient(projectUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
