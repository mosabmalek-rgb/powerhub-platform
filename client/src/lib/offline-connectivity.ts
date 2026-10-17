import { useEffect, useState } from "react";

export const POWERHUB_CONNECTIVITY_PROBE_TIMEOUT_MS = 3_500;
const HEALTH_PATH = "/api/health";
type HealthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let sharedProbe: Promise<boolean> | null = null;

async function runHealthProbe(fetcher: HealthFetch, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(HEALTH_PATH, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "cache-control": "no-cache" },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/** Check the PowerHub origin itself, not just the browser's optimistic online hint. */
export function probePowerHubConnectivity(
  fetcher: HealthFetch = globalThis.fetch,
  onlineHint = typeof navigator === "undefined" || navigator.onLine,
  timeoutMs = POWERHUB_CONNECTIVITY_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (!onlineHint) return Promise.resolve(false);
  if (fetcher === globalThis.fetch) {
    if (sharedProbe) return sharedProbe;
    sharedProbe = runHealthProbe(fetcher, timeoutMs).finally(() => {
      sharedProbe = null;
    });
    return sharedProbe;
  }
  return runHealthProbe(fetcher, timeoutMs);
}

/** Verified reachability and a counter that increments only after a real reconnection. */
export function usePowerHubConnectivity() {
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [reconnectGeneration, setReconnectGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    let lastReachable = typeof navigator === "undefined" ? true : navigator.onLine;

    const check = async () => {
      const reachable = await probePowerHubConnectivity();
      if (!active) return;
      setIsOnline(reachable);
      if (reachable && !lastReachable) setReconnectGeneration((generation) => generation + 1);
      lastReachable = reachable;
    };
    const handleOffline = () => {
      lastReachable = false;
      setIsOnline(false);
    };
    const handleOnline = () => { void check(); };
    const handleVisible = () => {
      if (document.visibilityState === "visible") void check();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisible);
    void check();
    return () => {
      active = false;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisible);
    };
  }, []);

  return { isOnline, reconnectGeneration };
}
