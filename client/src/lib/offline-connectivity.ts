import { useEffect, useState } from "react";

export const POWERHUB_CONNECTIVITY_PROBE_TIMEOUT_MS = 3_500;
export const POWERHUB_CONNECTIVITY_RECHECK_INTERVAL_MS = 15_000;
const HEALTH_PATH = "/api/health";
const PROBE_ATTEMPTS = 2;
type HealthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let sharedProbe: Promise<boolean> | null = null;

async function runHealthProbe(fetcher: HealthFetch, timeoutMs: number): Promise<boolean> {
  // A single short network hiccup must not flip the whole app into offline
  // mode. Retry once inside the same bounded window before declaring it down.
  const attemptTimeoutMs = Math.max(750, Math.floor(timeoutMs / PROBE_ATTEMPTS));

  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), attemptTimeoutMs);
    try {
      const response = await fetcher(HEALTH_PATH, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "cache-control": "no-cache" },
        signal: controller.signal,
      });
      if (response.ok) return true;
    } catch {
      // Retry once: browser connectivity hints and transient request failures
      // are not sufficient evidence that the PowerHub origin is unreachable.
    } finally {
      clearTimeout(timeout);
    }
  }

  return false;
}

/** Verify actual PowerHub reachability; navigator.onLine is only a hint. */
export function probePowerHubConnectivity(
  fetcher: HealthFetch = globalThis.fetch,
  _onlineHint = typeof navigator === "undefined" || navigator.onLine,
  timeoutMs = POWERHUB_CONNECTIVITY_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  // Do not short-circuit when navigator.onLine is false. That event is
  // frequently unreliable on desktop Wi-Fi/VPN setups; same-origin health
  // fetch is the real signal of whether the app can reach its server.
  if (fetcher === globalThis.fetch) {
    if (sharedProbe) return sharedProbe;
    sharedProbe = runHealthProbe(fetcher, timeoutMs).finally(() => {
      sharedProbe = null;
    });
    return sharedProbe;
  }
  return runHealthProbe(fetcher, timeoutMs);
}

/**
 * React Query's online manager represents browser/network reachability, not
 * whether one particular application health endpoint is responding. Keep that
 * signal separate from the PowerHub health probe below.
 */
export function subscribeBrowserNetworkStatus(
  setOnline: (online: boolean) => void,
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
  onlineHint: () => boolean = () => typeof navigator === "undefined" || navigator.onLine,
) {
  const sync = () => setOnline(onlineHint());
  target.addEventListener("online", sync);
  target.addEventListener("offline", sync);
  sync();
  return () => {
    target.removeEventListener("online", sync);
    target.removeEventListener("offline", sync);
  };
}

/** Verified reachability and a counter that increments only after a real reconnection. */
export function usePowerHubConnectivity() {
  // Avoid displaying a false offline banner based solely on the browser hint
  // while the first same-origin reachability probe is still running.
  const [isOnline, setIsOnline] = useState(true);
  const [initialCheckComplete, setInitialCheckComplete] = useState(false);
  const [reconnectGeneration, setReconnectGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    let lastReachable: boolean | null = null;

    const check = async () => {
      const reachable = await probePowerHubConnectivity();
      if (!active) return;
      setIsOnline(reachable);
      setInitialCheckComplete(true);
      if (reachable && lastReachable === false) setReconnectGeneration((generation) => generation + 1);
      lastReachable = reachable;
    };
    // An "offline" browser event may be a false positive. Verify the app origin
    // before changing the UI/React Query network state instead of flipping it
    // offline immediately.
    const handleOffline = () => { void check(); };
    const handleOnline = () => { void check(); };
    const handleVisible = () => {
      if (document.visibilityState === "visible") void check();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisible);
    void check();
    // Recover from a transient health-check failure even if the browser emits
    // no new online event (common after a brief API/Vercel cold-start hiccup).
    const retryId = window.setInterval(() => { void check(); }, POWERHUB_CONNECTIVITY_RECHECK_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(retryId);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisible);
    };
  }, []);

  return { isOnline, isChecking: !initialCheckComplete, reconnectGeneration };
}
