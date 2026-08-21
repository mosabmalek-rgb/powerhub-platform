import { describe, expect, it } from "vitest";
import { generateSubscriberReference, renderSubscriberReferenceMessage, subscriberReferenceTemplateParameters } from "./powerhub";

describe("generateSubscriberReference", () => {
  it("creates a normalized PowerHub reference with a random suffix", () => {
    const references = new Set(Array.from({ length: 24 }, () => generateSubscriberReference("north-zone_01")));
    expect(references.size).toBe(24);
    for (const reference of references) expect(reference).toMatch(/^PH-NORTHZONE01-[A-F0-9]{6}$/);
  });

  it("renders the portal instructions and Meta template parameters for a new subscriber", () => {
    const input = { subscriberName: "أحمد علي", subscriberNo: "PH-NORTH-AB12CD", portalCode: "north" };
    expect(renderSubscriberReferenceMessage(input)).toContain("PH-NORTH-AB12CD");
    expect(renderSubscriberReferenceMessage(input)).toContain("/portal?g=north");
    expect(subscriberReferenceTemplateParameters(input)).toEqual(["أحمد علي", "PH-NORTH-AB12CD", "/portal?g=north"]);
  });
});
