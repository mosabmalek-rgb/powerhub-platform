import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(new URL("./NetworkDirectoryPage.tsx", import.meta.url), "utf8");

describe("subscriber directory performance contract", () => {
  it("debounces search input before issuing directory queries", () => {
    expect(pageSource).toContain("setTimeout(() => {");
    expect(pageSource).toContain("setDebouncedSubscriberSearch(normalizedSearch);");
    expect(pageSource).toContain("search: debouncedSubscriberSearch");
    expect(pageSource).not.toContain("search: subscriberSearch");
  });

  it("keeps recently fetched pages responsive and preloads the next page", () => {
    expect(pageSource).toContain("staleTime: 30_000");
    expect(pageSource).toContain("placeholderData: (previousData) => previousData");
    expect(pageSource).toContain("directoryPage.prefetch({");
    expect(pageSource).toContain("subscribersQuery.isPlaceholderData");
  });
});
