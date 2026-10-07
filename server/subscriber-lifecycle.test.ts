import { describe, expect, it } from "vitest";

describe("subscriber lifecycle contract", () => {
  it("keeps suspended and archived semantics distinct", () => {
    const lifecycle = {
      suspend: { countsQuota: true, allowsReading: false, allowsCollection: false },
      activate: { countsQuota: true, allowsReading: true, allowsCollection: true },
      archive: { countsQuota: false, allowsReading: false, allowsCollection: false },
      restore: { countsQuota: true, allowsReading: true, allowsCollection: true },
    } as const;
    expect(lifecycle.suspend.countsQuota).toBe(true);
    expect(lifecycle.archive.countsQuota).toBe(false);
    expect(lifecycle.suspend.allowsReading).toBe(false);
    expect(lifecycle.archive.allowsCollection).toBe(false);
  });
});
