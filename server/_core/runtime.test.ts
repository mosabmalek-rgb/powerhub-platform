import { describe, expect, it } from "vitest";
import { isVercelRuntime } from "./runtime";

describe("Vercel runtime detection", () => {
  it("only disables the standalone listener for Vercel serverless functions", () => {
    expect(isVercelRuntime({})).toBe(false);
    expect(isVercelRuntime({ VERCEL: "0" })).toBe(false);
    expect(isVercelRuntime({ VERCEL: "1" })).toBe(true);
  });
});
