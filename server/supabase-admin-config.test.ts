import { describe, expect, it } from "vitest";

const runSupabaseIntegration = process.env.SUPABASE_INTEGRATION_TESTS === "true";

describe.skipIf(!runSupabaseIntegration)("Supabase administrative credentials", () => {
  it("accepts the configured service role at the Auth users endpoint", async () => {
    const projectUrl = process.env.VITE_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(projectUrl).toMatch(/^https:\/\/[a-z0-9-]+\.supabase\.co$/);
    expect(serviceRoleKey).toBeTruthy();

    const response = await fetch(`${projectUrl}/auth/v1/admin/users?page=1&per_page=1`, {
      headers: { apikey: serviceRoleKey!, Authorization: `Bearer ${serviceRoleKey}` },
    });
    expect(response.ok).toBe(true);
  });
});
