import { afterEach, describe, expect, it, vi } from "vitest";
import { logSafeSupabaseWorkerQueryFailure } from "./safe-supabase-worker-error";

describe("safe Supabase worker diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs a bounded error code and redacts credential-like values", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logSafeSupabaseWorkerQueryFailure("unified-messaging", "stale-message reclaim", {
      code: "PGRST202",
      message: "Bearer abc123 api_key=publishable-secret password:private token=hidden",
    });

    expect(log).toHaveBeenCalledWith("[unified-messaging] stale-message reclaim failed", {
      code: "PGRST202",
      message: "Bearer [REDACTED] api_key=[REDACTED] password=[REDACTED] token=[REDACTED]",
    });
    const serialized = JSON.stringify(log.mock.calls);
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("publishable-secret");
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("hidden");
  });

  it("does not emit arbitrary error codes and truncates oversized messages", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSafeSupabaseWorkerQueryFailure("unified-messaging", "automation query", {
      code: "PGRST202\nsecret",
      message: "x".repeat(900),
    });

    const payload = log.mock.calls[0][1] as { code: string; message: string };
    expect(payload.code).toBe("unknown");
    expect(payload.message).toHaveLength(500);
  });
});
