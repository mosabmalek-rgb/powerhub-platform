import { afterEach, describe, expect, it, vi } from "vitest";
import { measureSlowStage } from "./performance-telemetry";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("privacy-safe stage latency telemetry", () => {
  it("logs slow stage names and duration without request payloads", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(410);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await measureSlowStage("invoices.publicByToken", "shared_invoice_lookup_rpc", async () => ({ ok: true, token: "must-not-be-logged" }), 250);
    expect(result.ok).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toBe("[PowerHub stage latency]");
    expect(warn.mock.calls[0][1]).toMatchObject({ operation: "invoices.publicByToken", stage: "shared_invoice_lookup_rpc", durationMs: 400 });
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain("must-not-be-logged");
  });

  it("does not log stages below the configured threshold", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(80);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(measureSlowStage("readings.approve", "atomic_approval_rpc", async () => "ok", 250)).resolves.toBe("ok");
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a slow stage even when the operation throws, then preserves the error", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(310);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = new Error("safe test failure");
    await expect(measureSlowStage("paymentDocumentation.approve", "atomic_approval_rpc", async () => { throw error; }, 250)).rejects.toBe(error);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][1]).toMatchObject({ durationMs: 300, stage: "atomic_approval_rpc" });
  });
});
