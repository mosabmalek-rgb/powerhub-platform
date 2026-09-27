import { beforeEach, describe, expect, it, vi } from "vitest";

const upload = vi.fn();
const createSignedUrl = vi.fn();
const from = vi.fn(() => ({ upload, createSignedUrl }));

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({ storage: { from } }),
}));

describe("Supabase Storage adapter", () => {
  beforeEach(() => {
    vi.resetModules();
    upload.mockReset();
    createSignedUrl.mockReset();
    from.mockClear();
    upload.mockResolvedValue({ data: { path: "payment-receipts/1/INV-1_abcd1234.jpg" }, error: null });
    createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://storage.example.test/signed" }, error: null });
  });

  it("uploads a private attachment then returns a short-lived signed URL", async () => {
    const { storagePut } = await import("./storage");

    const result = await storagePut("/payment-receipts/1/INV-1.jpg", Buffer.from("image"), "image/jpeg");

    expect(from).toHaveBeenCalledWith("powerhub-private");
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(/^payment-receipts\/1\/INV-1_[a-f0-9]{8}\.jpg$/),
      expect.any(Buffer),
      { contentType: "image/jpeg", upsert: false },
    );
    expect(createSignedUrl).toHaveBeenCalledWith("payment-receipts/1/INV-1_abcd1234.jpg", 600);
    expect(result).toEqual({
      key: "payment-receipts/1/INV-1_abcd1234.jpg",
      url: "https://storage.example.test/signed",
    });
  });

  it("fails closed when Supabase rejects signing", async () => {
    const { storageGetSignedUrl } = await import("./storage");
    createSignedUrl.mockResolvedValue({ data: null, error: { message: "denied" } });

    await expect(storageGetSignedUrl("receipt.jpg")).rejects.toThrow("Supabase Storage signing failed: denied");
  });

  it.each(["../secret.jpg", "tenant/../../secret.jpg", "tenant\\secret.jpg", "./receipt.jpg"])("rejects unsafe storage key %s", async (key) => {
    const { storageGetSignedUrl } = await import("./storage");

    await expect(storageGetSignedUrl(key)).rejects.toThrow("Storage key is invalid");
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
});
