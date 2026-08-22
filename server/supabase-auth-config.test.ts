import { describe, expect, it } from "vitest";

const runSupabaseIntegration = process.env.SUPABASE_INTEGRATION_TESTS === "true";

describe.skipIf(!runSupabaseIntegration)("Supabase Auth configuration", () => {
  it("accepts the configured public API credentials at the Auth health endpoint", async () => {
    const projectUrl = process.env.VITE_SUPABASE_URL;
    const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

    expect(projectUrl).toMatch(/^https:\/\/[a-z0-9-]+\.supabase\.co$/);
    expect(publishableKey).toBeTruthy();

    const response = await fetch(`${projectUrl}/auth/v1/health`, {
      headers: { apikey: publishableKey! },
    });

    expect(response.ok).toBe(true);
  });
});
