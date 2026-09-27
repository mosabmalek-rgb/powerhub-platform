import { supabaseAdmin } from "./supabase-admin";

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "powerhub-private";
const SIGNED_URL_TTL_SECONDS = 60 * 10;

function normalizeKey(relKey: string): string {
  const key = relKey.trim().replace(/^\/+/, "");
  if (!key || key.includes("\\") || key.split("/").some((part) => part === ".." || part === ".")) {
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

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  const key = appendHashSuffix(normalizeKey(relKey));
  const { data: uploaded, error } = await supabaseAdmin().storage
    .from(STORAGE_BUCKET)
    .upload(key, data, { contentType, upsert: false });

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
