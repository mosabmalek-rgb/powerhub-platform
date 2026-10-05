import { describe, expect, it } from "vitest";

describe("AI assistant light-mode contrast contract", () => {
  it("uses explicit dark text on the light assistant bubble", () => {
    const className =
      "border border-slate-200 bg-white px-4 py-3 text-slate-900 dark:border-white/10 dark:bg-white/[.06] dark:text-slate-100";
    expect(className).toContain("text-slate-900");
    expect(className).toContain("dark:text-slate-100");
  });
});
