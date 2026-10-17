import { describe, expect, it, vi } from "vitest";
import { probePowerHubConnectivity } from "./offline-connectivity";

describe("PowerHub connectivity probe", () => {
  it("does not issue a request when the browser reports no network", async () => {
    const fetcher = vi.fn(async () => new Response("ok", { status: 200 }));
    await expect(probePowerHubConnectivity(fetcher, false)).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires a successful response from the PowerHub health endpoint", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/health");
      expect(init?.cache).toBe("no-store");
      expect(init?.credentials).toBe("same-origin");
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    });
    await expect(probePowerHubConnectivity(fetcher, true)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats server errors and network failures as unavailable", async () => {
    await expect(
      probePowerHubConnectivity(async () => new Response("unavailable", { status: 503 }), true),
    ).resolves.toBe(false);
    await expect(
      probePowerHubConnectivity(async () => { throw new Error("network unavailable"); }, true),
    ).resolves.toBe(false);
  });
});
