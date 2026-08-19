import { describe, expect, it } from "vitest";
import { OfflineQueueError, assertOfflineQueueAvailable } from "./offline-reading-queue";

describe("offline reading queue support", () => {
  it("reports a clear error when IndexedDB is unavailable", () => {
    if (typeof indexedDB !== "undefined") return;
    expect(() => assertOfflineQueueAvailable()).toThrow(OfflineQueueError);
  });
});
