import { createClient } from "@supabase/supabase-js";

const email = process.argv[2]?.trim().toLowerCase();
if (!email) throw new Error("Usage: node scripts/inspect-supabase-admin.mjs <email>");

const url = process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) throw new Error("Supabase administrative credentials are unavailable.");

const client = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data, error } = await client.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (error) throw error;

const user = data.users.find((candidate) => candidate.email?.trim().toLowerCase() === email);
console.log(JSON.stringify(user ? {
  found: true,
  id: user.id,
  email: user.email,
  confirmedAt: user.email_confirmed_at,
} : { found: false, email }));
