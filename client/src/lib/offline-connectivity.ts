import { useEffect, useState } from "react";

export const POWERHUB_CONNECTIVITY_PROBE_TIMEOUT_MS = 5_000;
export const POWERHUB_CONNECTIVITY_RECHECK_INTERVAL_MS = 15_000;
const UNKNOWN_REACHABILITY_RETRY_DELAY_MS = 1_500;
const FAILED_PROBE_CYCLES_TO_DECLARE_OFFLINE = 2;
const INITIAL_FAILED_PROBE_CYCLES_TO_DECLARE_OFFLINE = 3;
const MIN_FAILED_PROBE_DURATION_MS = 8_000;
const HEALTH_PATH = "/api/health";
const PROBE_ATTEMPTS = 2;

// Observe server time for clock-skew diagnostics; never extend token validity.
export const POWERHUB_DEVICE_CLOCK_SKEW_THRESHOLD_MS = 5 * 60 * 1_000;
export const POWERHUB_DEVICE_CLOCK_SKEW_USER_MESSAGE = "ساعة جهازك غير متزامنة مع وقت خادم PowerHub. صحّح التاريخ والوقت والمنطقة الزمنية وفعّل المزامنة التلقائية، ثم أعد تحميل الصفحة وحاول مرة أخرى. لم تُمسح بيانات العمل أو العمليات المعلقة.";
let lastPowerHubClockOffsetMs: number | null = null;

export function estimatePowerHubDeviceClockOffsetMs(serverDateHeader: string | null | undefined, requestStartedAtMs: number, responseReceivedAtMs: number): number | null {
  if (!serverDateHeader || !Number.isFinite(requestStartedAtMs) || !Number.isFinite(responseReceivedAtMs) || responseReceivedAtMs < requestStartedAtMs) return null;
  const serverTimeMs = Date.parse(serverDateHeader);
  if (!Number.isFinite(serverTimeMs)) return null;
  return Math.round(requestStartedAtMs + (responseReceivedAtMs - requestStartedAtMs) / 2 - serverTimeMs);
}
export function isDeviceClockOffsetOutsideTolerance(offsetMs: number | null | undefined): boolean {
  return typeof offsetMs === "number" && Number.isFinite(offsetMs) && Math.abs(offsetMs) > POWERHUB_DEVICE_CLOCK_SKEW_THRESHOLD_MS;
}
export function getPowerHubClockDiagnostics() {
  return { sampleAvailable: lastPowerHubClockOffsetMs !== null, localMinusServerMs: lastPowerHubClockOffsetMs, skewDetected: isDeviceClockOffsetOutsideTolerance(lastPowerHubClockOffsetMs), thresholdMs: POWERHUB_DEVICE_CLOCK_SKEW_THRESHOLD_MS };
}

/** Clear only the cached clock observation; the next health probe must supply a fresh sample. */
export function resetPowerHubClockObservation(): void {
  lastPowerHubClockOffsetMs = null;
}
type HealthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let sharedProbe: Promise<boolean> | null = null;
let lastVerifiedPowerHubReachability: boolean | null = null;
let consecutiveFailedProbeCycles = 0;
let firstFailedProbeAtMs: number | null = null;

/** Require repeated failed health-check cycles before declaring the origin unavailable. */
export function nextPowerHubReachabilityState(
  current: boolean | null,
  consecutiveFailures: number,
  probeReachable: boolean,
  failedDurationMs = 0,
): { reachable: boolean | null; consecutiveFailures: number } {
  if (probeReachable) return { reachable: true, consecutiveFailures: 0 };
  const nextFailures = consecutiveFailures + 1;
  const requiredFailures = current === null
    ? INITIAL_FAILED_PROBE_CYCLES_TO_DECLARE_OFFLINE
    : FAILED_PROBE_CYCLES_TO_DECLARE_OFFLINE;
  const failureWindowElapsed = failedDurationMs >= MIN_FAILED_PROBE_DURATION_MS;
  return {
    reachable: nextFailures >= requiredFailures && failureWindowElapsed ? false : current,
    consecutiveFailures: nextFailures,
  };
}

/**
 * null means no completed same-origin health probe exists for this page load.
 * Protected request transport can use this to avoid requests before readiness.
 */
export function getPowerHubConnectivitySnapshot(): boolean | null {
  return lastVerifiedPowerHubReachability;
}

async function runHealthProbe(fetcher: HealthFetch, timeoutMs: number): Promise<boolean> {
  // A single short network hiccup must not flip the whole app into offline
  // mode. Retry once inside the same bounded window before declaring it down.
  const attemptTimeoutMs = Math.max(750, Math.floor(timeoutMs / PROBE_ATTEMPTS));

  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), attemptTimeoutMs);
    try {
      const requestStartedAtMs = Date.now();
      const response = await fetcher(HEALTH_PATH, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "cache-control": "no-cache" },
        signal: controller.signal,
      });
      const offsetMs = estimatePowerHubDeviceClockOffsetMs(response.headers.get("date"), requestStartedAtMs, Date.now());
      if (offsetMs !== null) lastPowerHubClockOffsetMs = offsetMs;
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
    const probeStartedAt = Date.now();
    sharedProbe = runHealthProbe(fetcher, timeoutMs).then((reachable) => {
      const completedAt = Date.now();
      if (reachable) {
        firstFailedProbeAtMs = null;
      } else if (firstFailedProbeAtMs === null) {
        firstFailedProbeAtMs = probeStartedAt;
      }
      const failedDurationMs = firstFailedProbeAtMs === null ? 0 : completedAt - firstFailedProbeAtMs;
      const next = nextPowerHubReachabilityState(
        lastVerifiedPowerHubReachability,
        consecutiveFailedProbeCycles,
        reachable,
        failedDurationMs,
      );
      lastVerifiedPowerHubReachability = next.reachable;
      consecutiveFailedProbeCycles = next.consecutiveFailures;
      return reachable;
    }).finally(() => {
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
  // Unknown reachability is not an offline verdict. Keep authentication and
  // the shell recoverable while a repeated origin check resolves the signal.
  const [isOnline, setIsOnline] = useState(true);
  const [initialCheckComplete, setInitialCheckComplete] = useState(false);
  const [reconnectGeneration, setReconnectGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    let lastReachable: boolean | null = getPowerHubConnectivitySnapshot();
    let unknownRetryId: number | undefined;

    const clearUnknownRetry = () => {
      if (unknownRetryId !== undefined) {
        window.clearTimeout(unknownRetryId);
        unknownRetryId = undefined;
      }
    };

    const check = async () => {
      const probeReachable = await probePowerHubConnectivity();
      if (!active) return;

      const verifiedReachability = getPowerHubConnectivitySnapshot();
      setInitialCheckComplete(true);
      if (verifiedReachability === null) {
        // One failed probe is inconclusive. Do not flip the banner or prevent
        // a fresh login merely because the health endpoint had one transient miss.
        setIsOnline(true);
        if (!probeReachable && unknownRetryId === undefined) {
          unknownRetryId = window.setTimeout(() => {
            unknownRetryId = undefined;
            void check();
          }, UNKNOWN_REACHABILITY_RETRY_DELAY_MS);
        } else if (probeReachable) {
          clearUnknownRetry();
        }
        return;
      }

      clearUnknownRetry();
      setIsOnline(verifiedReachability);
      if (verifiedReachability && lastReachable === false) {
        setReconnectGeneration((generation) => generation + 1);
      }
      lastReachable = verifiedReachability;
    };
    // Browser online/offline events are hints; the health endpoint and repeated
    // probe result determine whether the PowerHub origin is actually reachable.
    const handleOffline = () => { void check(); };
    const handleOnline = () => { void check(); };
    const handleVisible = () => {
      if (document.visibilityState === "visible") void check();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisible);
    void check();
    const retryId = window.setInterval(() => { void check(); }, POWERHUB_CONNECTIVITY_RECHECK_INTERVAL_MS);
    return () => {
      active = false;
      clearUnknownRetry();
      window.clearInterval(retryId);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisible);
    };
  }, []);

  return { isOnline, isChecking: !initialCheckComplete, reconnectGeneration };
}
