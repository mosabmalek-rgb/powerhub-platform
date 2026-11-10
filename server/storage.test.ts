import { beforeEach, describe, expect, it, vi } from "vitest";

const upload = vi.fn();
const createSignedUrl = vi.fn();
const from = vi.fn(() => ({ upload, createSignedUrl }));

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({ storage: { from } }),
}));

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = Buffer.from("%PDF-1.7\n");

describe("Supabase Storage adapter", () => {
  beforeEach(() => {
    vi.resetModules();
    upload.mockReset();
    createSignedUrl.mockReset();
    from.mockClear();
    upload.mockResolvedValue({ data: { path: "payment-receipts/1/INV-1_abcd1234.jpg" }, error: null });
    createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://storage.example.test/signed" }, error: null });
  });

  it("uploads opening custody bytes without signing before a reviewer requests access", async () => {
    const { storagePutPrivate } = await import("./storage");
    createSignedUrl.mockRejectedValue(new Error("signing temporarily unavailable"));

    const result = await storagePutPrivate(
      "financial-opening-evidence/1/1/23/24/evidence.pdf", PDF, "application/pdf",
    );

    expect(upload).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(/^financial-opening-evidence\\/1\\/1\\/23\\/24\\/evidence_[a-f0-9]{8}\\.pdf$/),
      PDF,
      { contentType: "application/pdf", upsert: false },
    );
    expect(result).toEqual({ key: "payment-receipts/1/INV-1_abcd1234.jpg" });
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("uploads a private attachment then returns a short-lived signed URL", async () => {
    const { storagePut } = await import("./storage");

    const result = await storagePut("/payment-receipts/1/INV-1.jpg", JPEG, "image/jpeg");

    expect(from).toHaveBeenCalledWith("powerhub-private");
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(/^payment-receipts\/1\/INV-1_[a-f0-9]{8}\.jpg$/),
      JPEG,
      { contentType: "image/jpeg", upsert: false },
    );
    expect(createSignedUrl).toHaveBeenCalledWith("payment-receipts/1/INV-1_abcd1234.jpg", 600);
    expect(result).toEqual({
      key: "payment-receipts/1/INV-1_abcd1234.jpg",
      url: "https://storage.example.test/signed",
    });
  });

  it("normalizes MIME parameters and accepts the bucket's PDF allow-list entry", async () => {
    const { storagePut } = await import("./storage");

    await storagePut("documents/receipt.pdf", PDF, "Application/PDF; charset=binary");

    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(/^documents\/receipt_[a-f0-9]{8}\.pdf$/),
      PDF,
      { contentType: "application/pdf", upsert: false },
    );
  });

  it.each(["application/octet-stream", "text/html", "image/svg+xml", "image/gif"])(
    "rejects a MIME type outside the private bucket allow-list: %s",
    async (contentType) => {
      const { storagePut } = await import("./storage");

      await expect(storagePut("uploads/file.bin", JPEG, contentType)).rejects.toThrow(
        "Supabase Storage content type is not allowed",
      );
      expect(from).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["image/jpeg", Buffer.from("<html>not a jpeg</html>")],
    ["image/png", Buffer.from("<svg>not a png</svg>")],
    ["image/webp", Buffer.from("RIFFxxxxWAVE")],
    ["application/pdf", Buffer.from("<html>not a pdf</html>")],
  ])("rejects payload bytes that do not match %s", async (contentType, payload) => {
    const { storagePut } = await import("./storage");

    await expect(storagePut("uploads/mismatch", payload, contentType)).rejects.toThrow(
      "does not match its declared MIME type",
    );
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects empty payloads and files larger than the bucket maximum before upload", async () => {
    const { storagePut, STORAGE_MAX_FILE_SIZE_BYTES } = await import("./storage");
    const oversized = Buffer.alloc(STORAGE_MAX_FILE_SIZE_BYTES + 1);
    oversized.set(JPEG);

    await expect(storagePut("uploads/empty.jpg", Buffer.alloc(0), "image/jpeg")).rejects.toThrow(
      "payload is empty or invalid",
    );
    await expect(storagePut("uploads/large.jpg", oversized, "image/jpeg")).rejects.toThrow(
      "exceeds the 10 MB bucket limit",
    );
    expect(from).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase rejects signing", async () => {
    const { storageGetSignedUrl } = await import("./storage");
    createSignedUrl.mockResolvedValue({ data: null, error: { message: "denied" } });

    await expect(storageGetSignedUrl("receipt.jpg")).rejects.toThrow("Supabase Storage signing failed: denied");
  });

  it.each(["../secret.jpg", "tenant/../../secret.jpg", "tenant\\secret.jpg", "./receipt.jpg", "tenant//receipt.jpg"])(
    "rejects unsafe storage key %s",
    async (key) => {
      const { storageGetSignedUrl } = await import("./storage");

      await expect(storageGetSignedUrl(key)).rejects.toThrow("Storage key is invalid");
      expect(createSignedUrl).not.toHaveBeenCalled();
    },
  );
});
