// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { getPowerHubDeviceId } from "./offline-auth";

describe("getPowerHubDeviceId", () => {
  afterEach(() => {
    window.localStorage.removeItem("powerhub:device-id");
    vi.unstubAllGlobals();
  });

  it("keeps one identity when IndexedDB is unavailable and calls race", async () => {
    vi.stubGlobal("indexedDB", undefined);

    const ids = await Promise.all([
      getPowerHubDeviceId(),
      getPowerHubDeviceId(),
      getPowerHubDeviceId(),
    ]);

    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(window.localStorage.getItem("powerhub:device-id")).toBe(ids[0]);
  });
});
