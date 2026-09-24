// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { getPowerHubDeviceId } from "./offline-auth";

describe("getPowerHubDeviceId", () => {
  afterEach(() => {
    window.localStorage.removeItem("powerhub:device-id");
    vi.unstubAllGlobals();
  });

  it("keeps one identity when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);

    const first = await getPowerHubDeviceId();
    const second = await getPowerHubDeviceId();

    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second).toBe(first);
    expect(window.localStorage.getItem("powerhub:device-id")).toBe(first);
  });
});
