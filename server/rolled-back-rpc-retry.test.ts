import { describe, expect, it, vi } from "vitest";
import { retryRolledBackRpc } from "./rolled-back-rpc-retry";

const failure = (code: string) => ({ data: null, error: { code } });
const success = { data: [{ id: 1 }], error: null };

describe("bounded whole-RPC retry on confirmed database rollback", () => {
  it.each(["40P01", "40001"])("retries %s and returns the actual successful response", async (code) => {
    const invoke = vi.fn().mockResolvedValueOnce(failure(code)).mockResolvedValueOnce(success);
    await expect(retryRolledBackRpc("stable-operation-key", invoke)).resolves.toBe(success);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("returns the final rollback error after three total attempts", async () => {
    const final = failure("40001");
    const invoke = vi.fn().mockResolvedValueOnce(failure("40P01"))
      .mockResolvedValueOnce(failure("40P01")).mockResolvedValueOnce(final);
    await expect(retryRolledBackRpc("stable-operation-key", invoke)).resolves.toBe(final);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it.each(["", "P0001", "23505", "57014", "55P03", "08006", "PGRST000", "42501"])(
    "never retries ambiguous or non-rollback code %s", async (code) => {
      const result = failure(code);
      const invoke = vi.fn().mockResolvedValue(result);
      await expect(retryRolledBackRpc("stable-operation-key", invoke)).resolves.toBe(result);
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, null, "", "   ", "x".repeat(151)])("does not retry without a valid operation key", async (key) => {
    const result = failure("40P01");
    const invoke = vi.fn().mockResolvedValue(result);
    await expect(retryRolledBackRpc(key, invoke)).resolves.toBe(result);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not retry a thrown network exception or a successful response", async () => {
    const error = new Error("connection interrupted");
    const invoke = vi.fn().mockRejectedValueOnce(error);
    await expect(retryRolledBackRpc("stable-operation-key", invoke)).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledTimes(1);
    invoke.mockReset().mockResolvedValue(success);
    await expect(retryRolledBackRpc("stable-operation-key", invoke)).resolves.toBe(success);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
