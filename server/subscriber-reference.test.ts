import { describe, expect, it } from "vitest";
import { generateSubscriberReference } from "./powerhub";

describe("generateSubscriberReference", () => {
  it("creates a normalized PowerHub reference with a random suffix", () => {
    const references = new Set(Array.from({ length: 24 }, () => generateSubscriberReference("north-zone_01")));
    expect(references.size).toBe(24);
    for (const reference of references) expect(reference).toMatch(/^PH-NORTHZONE01-[A-F0-9]{6}$/);
  });
});
