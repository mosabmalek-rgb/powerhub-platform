// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { copyTextSafely, openWindowSafely } from "./clipboard";

describe("clipboard and popup safety helpers", () => {
  it("reports successful clipboard writes", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    await expect(copyTextSafely("رابط الفاتورة")).resolves.toBe(true);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("رابط الفاتورة");
  });

  it("does not claim success when no clipboard API is available", async () => {
    Object.assign(navigator, { clipboard: undefined });
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn().mockReturnValue(false) });
    await expect(copyTextSafely("نص")).resolves.toBe(false);
  });

  it("reports popup blocking instead of showing a false success", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await expect(openWindowSafely("/invoice/test")).resolves.toBe(false);
    open.mockRestore();
  });
});
