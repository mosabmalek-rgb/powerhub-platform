type StorageAccess = {
  storage: Storage | null;
  propertyAccessible: boolean;
};

function getStorage(kind: "localStorage" | "sessionStorage"): StorageAccess {
  try {
    return { storage: window[kind], propertyAccessible: true };
  } catch {
    return { storage: null, propertyAccessible: false };
  }
}

function probeStorage(storage: Storage | null): "available" | "blocked" | "unavailable" {
  if (!storage) return "unavailable";
  const key = "__powerhub_diagnostic_probe__" + Math.random().toString(36).slice(2);
  try {
    storage.setItem(key, "1");
    storage.removeItem(key);
    return "available";
  } catch {
    try { storage.removeItem(key); } catch { /* keep the report read-only after a failed probe */ }
    return "blocked";
  }
}

function inspectLocalStorageSignals(storage: Storage | null) {
  if (!storage) return { supabaseAuthStorageKeyCount: null, hasValidPersistedDeviceId: null };
  try {
    let supabaseAuthStorageKeyCount = 0;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && /^sb-[a-z0-9-]+-auth-token(?:\.\d+)?$/i.test(key)) {
        supabaseAuthStorageKeyCount += 1;
      }
    }
    const value = storage.getItem("powerhub:device-id");
    return {
      supabaseAuthStorageKeyCount,
      hasValidPersistedDeviceId: Boolean(value && /^[0-9a-f-]{36}$/i.test(value)),
    };
  } catch {
    return { supabaseAuthStorageKeyCount: null, hasValidPersistedDeviceId: null };
  }
}

function safeScriptPath(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    // Keep only the asset path/version; never copy an arbitrary cross-origin URL.
    if (url.origin !== window.location.origin) return "cross-origin";
    return url.pathname + url.search;
  } catch {
    return null;
  }
}

async function inspectKnownIndexedDatabases() {
  if (typeof indexedDB === "undefined") {
    return { available: false, inventory: "unavailable", offlineAuth: null, offlineCache: null, offlineWorkspace: null };
  }

  const factory = indexedDB as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string }>>;
  };
  if (typeof factory.databases !== "function") {
    return { available: true, inventory: "not-supported", offlineAuth: null, offlineCache: null, offlineWorkspace: null };
  }

  try {
    const databases = await factory.databases();
    const names = new Set(databases.map((database) => database.name).filter((name): name is string => Boolean(name)));
    return {
      available: true,
      inventory: "available",
      offlineAuth: names.has("powerhub-offline-auth"),
      offlineCache: names.has("powerhub-offline-cache"),
      offlineWorkspace: names.has("powerhub-offline-workspace"),
    };
  } catch (error) {
    return {
      available: true,
      inventory: error instanceof Error ? error.name : "inspection-failed",
      offlineAuth: null,
      offlineCache: null,
      offlineWorkspace: null,
    };
  }
}

async function inspectServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return { supported: false, controlled: false, controllerScript: null, activeState: null, activeScript: null, waitingState: null, waitingScript: null };
  }

  try {
    const controller = navigator.serviceWorker.controller;
    const registration = await navigator.serviceWorker.getRegistration();
    return {
      supported: true,
      controlled: Boolean(controller),
      controllerScript: safeScriptPath(controller?.scriptURL),
      activeState: registration?.active?.state ?? null,
      activeScript: safeScriptPath(registration?.active?.scriptURL),
      waitingState: registration?.waiting?.state ?? null,
      waitingScript: safeScriptPath(registration?.waiting?.scriptURL),
    };
  } catch (error) {
    return {
      supported: true,
      controlled: Boolean(navigator.serviceWorker.controller),
      controllerScript: safeScriptPath(navigator.serviceWorker.controller?.scriptURL),
      activeState: null,
      activeScript: null,
      waitingState: null,
      waitingScript: null,
      inspectionErrorName: error instanceof Error ? error.name : "UnknownError",
    };
  }
}

async function inspectStorageEstimate() {
  try {
    if (!navigator.storage?.estimate) return { available: false, usageMiBRounded: null, quotaMiBRounded: null };
    const estimate = await navigator.storage.estimate();
    const roundToFiveMiB = (value: number | undefined) =>
      typeof value === "number" && Number.isFinite(value) ? Math.round(value / (5 * 1024 * 1024)) * 5 : null;
    return {
      available: true,
      usageMiBRounded: roundToFiveMiB(estimate.usage),
      quotaMiBRounded: roundToFiveMiB(estimate.quota),
    };
  } catch {
    return { available: false, usageMiBRounded: null, quotaMiBRounded: null };
  }
}

function currentEntryAsset() {
  if (typeof document === "undefined") return null;
  const script = Array.from(document.querySelectorAll("script[src]"))
    .map((element) => element.getAttribute("src"))
    .find((src) => src && /\/assets\/index-[^/]+\.js(?:\?.*)?$/.test(src));
  return safeScriptPath(script);
}

/**
 * Gathers only environment and boolean state needed to compare a working and
 * failing browser. It never reads auth token values, user profile/cache rows,
 * Outbox payloads, emails, tenant identifiers, or the actual device ID.
 */
export async function collectSafeClientDiagnostics() {
  const localStorageAccess = getStorage("localStorage");
  const sessionStorageAccess = getStorage("sessionStorage");
  const localStorageProbe = localStorageAccess.propertyAccessible
    ? probeStorage(localStorageAccess.storage)
    : "inaccessible";
  const sessionStorageProbe = sessionStorageAccess.propertyAccessible
    ? probeStorage(sessionStorageAccess.storage)
    : "inaccessible";
  const localStorageSignals = inspectLocalStorageSignals(localStorageAccess.storage);

  let auth: Record<string, unknown>;
  try {
    const { getSupabaseSessionDiagnostics } = await import("./supabase");
    const snapshot = getSupabaseSessionDiagnostics();
    const tokenExpiresAt = snapshot.tokenExpiresAt;
    const tokenMinutesRemaining = typeof tokenExpiresAt === "number" && Number.isFinite(tokenExpiresAt)
      ? Math.floor((tokenExpiresAt - Date.now() / 1000) / 60)
      : null;
    auth = {
      available: true,
      sessionInitialized: snapshot.sessionInitialized,
      hasCurrentSession: snapshot.hasCurrentSession,
      hasAccessToken: snapshot.hasAccessToken,
      tokenExpirySource: snapshot.tokenExpirySource,
      tokenMinutesRemaining,
      tokenUsable: snapshot.tokenUsable,
      readInFlight: snapshot.readInFlight,
      readBackoffActive: snapshot.readBackoffActive,
      lastReadErrorName: snapshot.lastReadErrorName,
      refreshInFlight: snapshot.refreshInFlight,
      tokenResolution: {
        resolutionInFlight: snapshot.tokenResolution.resolutionInFlight,
        refreshBackoffActive: snapshot.tokenResolution.refreshBackoffActive,
        lastRefreshErrorName: snapshot.tokenResolution.lastRefreshErrorName,
      },
    };
  } catch (error) {
    auth = { available: false, diagnosticErrorName: error instanceof Error ? error.name : "UnknownError" };
  }

  let connectivity: Record<string, unknown>;
  try {
    const module = await import("./offline-connectivity");
    const previousSnapshot = module.getPowerHubConnectivitySnapshot();
    const reachable = await module.probePowerHubConnectivity();
    const currentSnapshot = module.getPowerHubConnectivitySnapshot();
    connectivity = {
      previousSnapshot: previousSnapshot === null ? "unknown" : previousSnapshot ? "reachable" : "unreachable",
      healthProbe: reachable ? "reachable" : "unreachable",
      currentSnapshot: currentSnapshot === null ? "unknown" : currentSnapshot ? "reachable" : "unreachable",
    };
  } catch (error) {
    connectivity = { healthProbe: "error", diagnosticErrorName: error instanceof Error ? error.name : "UnknownError" };
  }

  const databaseInventory = await inspectKnownIndexedDatabases();
  const serviceWorker = await inspectServiceWorker();
  const storageEstimate = await inspectStorageEstimate();
  const entryAsset = currentEntryAsset();

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    origin: window.location.origin,
    page: window.location.pathname === "/login" ? "login" : window.location.pathname === "/workspace" ? "workspace" : "other",
    browser: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      onlineHint: navigator.onLine,
      secureContext: window.isSecureContext,
    },
    build: { entryAsset },
    storage: {
      localStorageProbe,
      sessionStorageProbe,
      ...localStorageSignals,
      indexedDb: databaseInventory,
      estimate: storageEstimate,
    },
    serviceWorker,
    connectivity,
    auth,
    privacy: {
      includesTokens: false,
      includesUserProfile: false,
      includesEmail: false,
      includesDeviceId: false,
      includesCacheRowsOrOutbox: false,
    },
  };
}
