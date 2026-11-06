import { supabaseAdmin } from "./supabase-admin";

export const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "powerhub-private";
export const STORAGE_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 60 * 10;
const STORAGE_ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

function normalizeKey(relKey: string): string {
  const key = relKey.trim().replace(/^\/+/, "");
  const segments = key.split("/");
  if (
    !key ||
    Buffer.byteLength(key, "utf8") > 1024 ||
    key.includes("\\") ||
    key.includes("\0") ||
    segments.some((part) => !part || part === ".." || part === ".")
  ) {
    throw new Error("Supabase Storage key is invalid.");
  }
  return key;
}

function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

function validateUpload(
  data: Buffer | Uint8Array | string,
  contentType: string,
): { normalizedContentType: string; byteLength: number } {
  const normalizedContentType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!STORAGE_ALLOWED_MIME_TYPES.has(normalizedContentType)) {
    throw new Error("Supabase Storage content type is not allowed.");
  }

  const byteLength = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new Error("Supabase Storage upload payload is empty or invalid.");
  }
  if (byteLength > STORAGE_MAX_FILE_SIZE_BYTES) {
    throw new Error("Supabase Storage upload exceeds the 10 MB bucket limit.");
  }

  const bytes = typeof data === "string"
    ? Buffer.from(data, "utf8")
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const isJpeg = normalizedContentType === "image/jpeg"
    && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = normalizedContentType === "image/png"
    && bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = normalizedContentType === "image/webp"
    && bytes.length >= 12
    && bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.toString("ascii", 8, 12) === "WEBP";
  const isPdf = normalizedContentType === "application/pdf"
    && bytes.length >= 5
    && bytes.toString("ascii", 0, 5) === "%PDF-";

  if (!isJpeg && !isPng && !isWebp && !isPdf) {
    throw new Error("Supabase Storage content does not match its declared MIME type.");
  }

  return { normalizedContentType, byteLength };
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  const key = appendHashSuffix(normalizeKey(relKey));
  const { normalizedContentType } = validateUpload(data, contentType);
  const { data: uploaded, error } = await supabaseAdmin().storage
    .from(STORAGE_BUCKET)
    .upload(key, data, { contentType: normalizedContentType, upsert: false });

  if (error || !uploaded) {
    throw new Error(`Supabase Storage upload failed: ${error?.message ?? "unknown error"}`);
  }

  return { key: uploaded.path, url: await storageGetSignedUrl(uploaded.path) };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: await storageGetSignedUrl(key) };
}

export async function storageGetSignedUrl(relKey: string): Promise<string> {
  const key = normalizeKey(relKey);
  const { data, error } = await supabaseAdmin().storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(key, SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    throw new Error(`Supabase Storage signing failed: ${error?.message ?? "unknown error"}`);
  }

  return data.signedUrl;
}

export async function storageRemove(relKey: string): Promise<void> {
  const key = normalizeKey(relKey);
  const { error } = await supabaseAdmin().storage.from(STORAGE_BUCKET).remove([key]);
  if (error) throw new Error(`Supabase Storage removal failed: ${error.message}`);
}
