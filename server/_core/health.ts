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

export function readinessHandler(_req: unknown, res: Response) {
  noStore(res);
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const checks = {
    application: true,
    supabaseConfig: Boolean(supabaseUrl && publishableKey),
  };
  const ready = Object.values(checks).every(Boolean);

  res.status(ready ? 200 : 503).json({
    status: ready ? "ok" : "not_ready",
    service: "powerhub-platform",
    checks,
    timestamp: new Date().toISOString(),
  });
}
