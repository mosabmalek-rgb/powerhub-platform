export type AdaptiveDeltaRealtimeStatus = "disabled" | "connected" | "disconnected";

export type AdaptiveDeltaRefreshCheck = () => Promise<unknown> | unknown;

type RefreshEvents = {
  online: () => void;
  offline: () => void;
  visible: () => void;
  hidden: () => void;
};

type TimerHandle = ReturnType<typeof setTimeout>;

type RefreshRuntime = {
  isVisible: () => boolean;
  isOnline: () => boolean;
  random: () => number;
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
  subscribe: (events: RefreshEvents) => () => void;
};

type ScopeState = {
  key: string;
  checks: Set<AdaptiveDeltaRefreshCheck>;
  realtimeStatus: AdaptiveDeltaRealtimeStatus;
  timer: TimerHandle | null;
  debounceTimer: TimerHandle | null;
  inFlight: Promise<void> | null;
  pending: boolean;
  failures: number;
};

export type AdaptiveDeltaRefreshOptions = {
  pollingIntervalMs?: number;
  realtimeFallbackMinMs?: number;
  realtimeFallbackMaxMs?: number;
  invalidationDebounceMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
};

const DEFAULT_OPTIONS: Required<AdaptiveDeltaRefreshOptions> = {
  pollingIntervalMs: 30_000,
  realtimeFallbackMinMs: 60_000,
  realtimeFallbackMaxMs: 120_000,
  invalidationDebounceMs: 250,
  retryBaseMs: 30_000,
  retryMaxMs: 5 * 60_000,
};

function createBrowserRuntime(): RefreshRuntime {
  return {
    isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
    isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
    random: () => Math.random(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
    subscribe: (events) => {
      if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
      const online = () => events.online();
      const offline = () => events.offline();
      const visibility = () => {
        if (document.visibilityState === "visible") events.visible();
        else events.hidden();
      };
      window.addEventListener("online", online);
      window.addEventListener("offline", offline);
      document.addEventListener("visibilitychange", visibility);
      return () => {
        window.removeEventListener("online", online);
        window.removeEventListener("offline", offline);
        document.removeEventListener("visibilitychange", visibility);
      };
    },
  };
}

/**
 * One timer and one in-flight revision check per authenticated domain scope.
 *
 * This manager schedules revision checks only. It does not own Delta pulls,
 * mutate cached records, or bypass the server-authoritative query used by a page.
 */
export class AdaptiveDeltaRefreshManager {
  private readonly scopes = new Map<string, ScopeState>();
  private readonly options: Required<AdaptiveDeltaRefreshOptions>;
  private unsubscribeRuntime: (() => void) | null = null;

  constructor(
    private readonly runtime: RefreshRuntime = createBrowserRuntime(),
    options: AdaptiveDeltaRefreshOptions = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  register(scopeKey: string, check: AdaptiveDeltaRefreshCheck): () => void {
    const normalizedKey = scopeKey.trim();
    if (!normalizedKey) throw new Error("Adaptive Delta refresh requires a non-empty scope key.");

    let state = this.scopes.get(normalizedKey);
    if (!state) {
      state = {
        key: normalizedKey,
        checks: new Set(),
        realtimeStatus: "disabled",
        timer: null,
        debounceTimer: null,
        inFlight: null,
        pending: false,
        failures: 0,
      };
      this.scopes.set(normalizedKey, state);
    }

    state.checks.add(check);
    this.ensureRuntimeSubscription();
    if (state.checks.size === 1) this.schedule(state);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.scopes.get(normalizedKey);
      if (!current) return;
      current.checks.delete(check);
      if (current.checks.size > 0) return;
      this.clearTimer(current);
      this.clearDebounce(current);
      this.scopes.delete(normalizedKey);
      if (this.scopes.size === 0) this.removeRuntimeSubscription();
    };
  }

  /** Coalesce explicit Realtime invalidation events into one revision read. */
  invalidate(scopeKey: string): void {
    const state = this.scopes.get(scopeKey);
    if (!state || state.checks.size === 0) return;
    if (!this.canRun()) {
      state.pending = true;
      return;
    }
    if (state.inFlight) {
      state.pending = true;
      return;
    }
    this.clearTimer(state);
    this.clearDebounce(state);
    state.debounceTimer = this.runtime.setTimeout(() => {
      state.debounceTimer = null;
      void this.runCheck(state);
    }, this.options.invalidationDebounceMs);
  }

  /** Called by the Realtime adapter after SUBSCRIBED / CHANNEL_ERROR / CLOSED. */
  setRealtimeStatus(scopeKey: string, status: AdaptiveDeltaRealtimeStatus): void {
    const state = this.scopes.get(scopeKey);
    if (!state || state.realtimeStatus === status) return;
    const previous = state.realtimeStatus;
    state.realtimeStatus = status;
    this.clearTimer(state);
    this.clearDebounce(state);

    if (status === "connected") {
      if (previous !== "connected") void this.runCheck(state);
      else this.schedule(state);
      return;
    }
    this.schedule(state);
  }

  /** Small observable snapshot used by tests and diagnostics; it contains no user data. */
  getScopeState(scopeKey: string) {
    const state = this.scopes.get(scopeKey);
    if (!state) return null;
    return {
      checkCount: state.checks.size,
      realtimeStatus: state.realtimeStatus,
      inFlight: state.inFlight !== null,
      pending: state.pending,
      failures: state.failures,
      hasTimer: state.timer !== null,
      hasDebounce: state.debounceTimer !== null,
    };
  }

  private ensureRuntimeSubscription(): void {
    if (this.unsubscribeRuntime) return;
    this.unsubscribeRuntime = this.runtime.subscribe({
      online: () => this.refreshVisibleScopes(),
      visible: () => this.refreshVisibleScopes(),
      offline: () => this.pauseScopes(),
      hidden: () => this.pauseScopes(),
    });
  }

  private removeRuntimeSubscription(): void {
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
  }

  private canRun(): boolean {
    return this.runtime.isVisible() && this.runtime.isOnline();
  }

  private refreshVisibleScopes(): void {
    if (!this.canRun()) {
      this.pauseScopes();
      return;
    }
    for (const state of this.scopes.values()) {
      this.clearTimer(state);
      this.clearDebounce(state);
      void this.runCheck(state);
    }
  }

  private pauseScopes(): void {
    for (const state of this.scopes.values()) {
      this.clearTimer(state);
      this.clearDebounce(state);
    }
  }

  private async runCheck(state: ScopeState): Promise<void> {
    if (this.scopes.get(state.key) !== state || state.checks.size === 0) return;
    if (!this.canRun()) {
      state.pending = true;
      return;
    }
    if (state.inFlight) {
      state.pending = true;
      return state.inFlight;
    }

    state.pending = false;
    this.clearTimer(state);
    this.clearDebounce(state);
    const checks = [...state.checks];
    const work = Promise.allSettled(checks.map((check) => Promise.resolve().then(check)));
    let flight!: Promise<void>;
    flight = work.then((results) => {
      if (this.scopes.get(state.key) !== state) return;
      state.failures = results.some((result) => result.status === "rejected")
        ? state.failures + 1
        : 0;
    }).finally(() => {
      if (this.scopes.get(state.key) !== state || state.inFlight !== flight) return;
      state.inFlight = null;
      if (state.pending && this.canRun()) {
        state.pending = false;
        void this.runCheck(state);
      } else {
        this.schedule(state);
      }
    });
    state.inFlight = flight;
    return flight;
  }

  private schedule(state: ScopeState): void {
    this.clearTimer(state);
    if (this.scopes.get(state.key) !== state || state.checks.size === 0 || !this.canRun()) return;
    if (state.inFlight || state.debounceTimer) return;
    if (state.realtimeStatus === "connected" && state.failures === 0) return;

    let delayMs = this.options.pollingIntervalMs;
    if (state.realtimeStatus === "disconnected") {
      const span = this.options.realtimeFallbackMaxMs - this.options.realtimeFallbackMinMs;
      delayMs = this.options.realtimeFallbackMinMs + Math.floor(this.runtime.random() * (span + 1));
    }
    if (state.failures > 0) {
      const backoff = Math.min(
        this.options.retryMaxMs,
        this.options.retryBaseMs * (2 ** Math.min(state.failures - 1, 8)),
      );
      const jitter = 0.8 + this.runtime.random() * 0.4;
      delayMs = Math.min(this.options.retryMaxMs, Math.max(delayMs, Math.round(backoff * jitter)));
    }

    state.timer = this.runtime.setTimeout(() => {
      state.timer = null;
      void this.runCheck(state);
    }, delayMs);
  }

  private clearTimer(state: ScopeState): void {
    if (state.timer === null) return;
    this.runtime.clearTimeout(state.timer);
    state.timer = null;
  }

  private clearDebounce(state: ScopeState): void {
    if (state.debounceTimer === null) return;
    this.runtime.clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  }
}

export const adaptiveDeltaRefreshManager = new AdaptiveDeltaRefreshManager();
