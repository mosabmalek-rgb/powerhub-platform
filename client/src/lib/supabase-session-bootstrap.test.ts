import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listeners: [] as Array<(event: string, session: unknown) => void>,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      onAuthStateChange: (listener: (event: string, session: unknown) => void) => {
        mocks.listeners.push(listener);
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
      getSession: mocks.getSession,
    },
  }),
}));

function makeSession() {
  return {
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expires_at: Math.floor(Date.now() / 1000) + 3_600,
    user: { id: "user-1", email: "admin@powerhub.test" },
    token_type: "bearer",
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_SUPABASE_URL", "https://powerhub-test.supabase.co");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
  mocks.getSession.mockReset();
  mocks.listeners.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("successful sign-in session bootstrap", () => {
  it("makes the returned session immediately available and notifies AuthProvider synchronously", async () => {
    const auth = await import("./supabase");
    const session = makeSession();
    const events: Array<{ event: string; session: unknown }> = [];

    auth.subscribeSupabaseAuthState((event, value) => events.push({ event, session: value }));
    auth.acceptSupabaseSignInSession(session as never);

    expect(events).toEqual([{ event: "SIGNED_IN", session }]);
    await expect(auth.getSupabaseSession()).resolves.toEqual(session);
    expect(auth.getSupabaseSessionDiagnostics()).toMatchObject({
      sessionInitialized: true,
      hasCurrentSession: true,
      hasAccessToken: true,
      tokenUsable: true,
      lastReadErrorName: null,
      readBackoffActive: false,
    });
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("adopts a token-bearing sign-in response even when its local expiry hint requires SDK recovery", async () => {
    const auth = await import("./supabase");
    const expiredSession = {
      ...makeSession(),
      expires_at: Math.floor(Date.now() / 1000) - 30,
    };
    const events: Array<{ event: string; session: unknown }> = [];
    auth.subscribeSupabaseAuthState((event, value) => events.push({ event, session: value }));

    expect(() => auth.acceptSupabaseSignInSession(expiredSession as never)).not.toThrow();
    expect(events).toEqual([{ event: "SIGNED_IN", session: expiredSession }]);
    expect(auth.getSupabaseSessionDiagnostics()).toMatchObject({
      sessionInitialized: true,
      hasCurrentSession: true,
      hasAccessToken: true,
      tokenUsable: false,
    });
    // Session adoption is not token authorization: the access-token resolver
    // still refuses to return an expired or otherwise unusable bearer token.
    await expect(auth.getSupabaseAccessToken()).rejects.toMatchObject({
      name: expect.stringMatching(/^PowerHubSession/),
    });
  });

  it("still rejects a sign-in response missing identity or access token", async () => {
    const auth = await import("./supabase");
    expect(() => auth.acceptSupabaseSignInSession({ ...makeSession(), access_token: "" } as never))
      .toThrow("Supabase returned no session identity or access token after sign-in.");
  });

  it("does not let an older in-flight null session read overwrite the accepted sign-in", async () => {
    let finishRead!: (value: { data: { session: null }; error: null }) => void;
    mocks.getSession.mockImplementationOnce(() => new Promise((resolve) => {
      finishRead = resolve as (value: { data: { session: null }; error: null }) => void;
    }));

    const auth = await import("./supabase");
    const oldRead = auth.getSupabaseSession();
    expect(mocks.getSession).toHaveBeenCalledTimes(1);

    const session = makeSession();
    auth.acceptSupabaseSignInSession(session as never);
    finishRead({ data: { session: null }, error: null });

    await expect(oldRead).resolves.toEqual(session);
    await expect(auth.getSupabaseSession()).resolves.toEqual(session);
    expect(auth.getSupabaseSessionDiagnostics()).toMatchObject({
      hasCurrentSession: true,
      tokenUsable: true,
      lastReadErrorName: null,
    });
  });
});
