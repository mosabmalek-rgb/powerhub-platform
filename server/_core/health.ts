import type { Response } from "express";

export type PowerHubHealthState = "ok" | "not_ready";

function noStore(res: Response) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
}

export function healthHandler(_req: unknown, res: Response) {
  noStore(res);
  res.status(200).json({
    status: "ok" satisfies PowerHubHealthState,
    service: "powerhub-platform",
    timestamp: new Date().toISOString(),
  });
}

async function checkSupabaseConnectivity(
  supabaseUrl: string,
  publishableKey: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/settings`, {
      method: "GET",
      headers: {
        apikey: publishableKey,
      },
      signal: controller.signal,
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function readinessHandler(_req: unknown, res: Response) {
  noStore(res);
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const configReady = Boolean(supabaseUrl && publishableKey);

  const supabaseConnectivity = configReady
    ? await checkSupabaseConnectivity(supabaseUrl!, publishableKey!)
    : false;

  const checks = {
    application: true,
    supabaseConfig: configReady,
    supabaseConnectivity,
  };
  const ready = Object.values(checks).every(Boolean);

  // Expose only configuration presence; never return the secret value.
  const aiGatewayConfigured = Boolean(process.env.AI_GATEWAY_API_KEY);
  res.status(ready ? 200 : 503).json({
    status: ready ? "ok" : "not_ready",
    service: "powerhub-platform",
    checks,
    aiGatewayConfigured,
    timestamp: new Date().toISOString(),
  });
}
