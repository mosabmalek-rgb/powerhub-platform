import crypto from "node:crypto";
import type { Request, Response } from "express";
import { supabaseAdmin } from "./supabase-admin";
import { decryptTenantCredential, hashWebhookVerifyToken } from "./tenant-crypto";

type RawRequest = Request & { rawBody?: Buffer };
type WhatsAppCredential = { accessToken: string; appSecret?: string };
type WhatsAppChange = { value?: { statuses?: Array<{ id?: string; status?: string }> } };

function verifySignature(rawBody: Buffer | undefined, signature: string | undefined, appSecret: string | undefined) {
  if (!rawBody || !signature || !appSecret) return false;
  const expected = `sha256=${crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  const actual = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function readCredential(ciphertext: string, iv: string): WhatsAppCredential {
  const raw = decryptTenantCredential(ciphertext, iv);
  try { return JSON.parse(raw) as WhatsAppCredential; } catch { return { accessToken: raw }; }
}

export async function verifyWhatsAppWebhook(req: Request, res: Response) {
  const tenantId = Number(req.params.tenantId);
  const token = typeof req.query["hub.verify_token"] === "string" ? req.query["hub.verify_token"] : "";
  const challenge = typeof req.query["hub.challenge"] === "string" ? req.query["hub.challenge"] : "";
  if (!Number.isInteger(tenantId) || req.query["hub.mode"] !== "subscribe" || !token || !challenge) return res.sendStatus(403);

  const { data: configuration, error } = await supabaseAdmin()
    .from("tenant_messaging_configurations")
    .select("webhook_verify_token_hash")
    .eq("tenant_id", tenantId)
    .eq("channel", "whatsapp")
    .eq("is_active", true)
    .maybeSingle();
  if (error || !configuration?.webhook_verify_token_hash) return res.sendStatus(403);

  const expectedHash = Buffer.from(hashWebhookVerifyToken(token));
  const actualHash = Buffer.from(configuration.webhook_verify_token_hash);
  if (expectedHash.length !== actualHash.length || !crypto.timingSafeEqual(actualHash, expectedHash)) return res.sendStatus(403);
  return res.status(200).send(challenge);
}

export async function receiveWhatsAppWebhook(req: RawRequest, res: Response) {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isInteger(tenantId)) return res.sendStatus(404);

  const { data: configuration, error } = await supabaseAdmin()
    .from("tenant_messaging_configurations")
    .select("credential_ciphertext, credential_iv")
    .eq("tenant_id", tenantId)
    .eq("channel", "whatsapp")
    .eq("is_active", true)
    .maybeSingle();
  if (error) return res.status(503).json({ error: "database_unavailable" });
  if (!configuration?.credential_ciphertext || !configuration.credential_iv) return res.sendStatus(403);

  const credential = readCredential(configuration.credential_ciphertext, configuration.credential_iv);
  const signature = typeof req.headers["x-hub-signature-256"] === "string" ? req.headers["x-hub-signature-256"] : undefined;
  if (!verifySignature(req.rawBody, signature, credential.appSecret)) return res.sendStatus(403);

  const admin = supabaseAdmin();
  const changes = (req.body?.entry ?? []).flatMap((entry: { changes?: WhatsAppChange[] }) => entry.changes ?? []);
  for (const change of changes) for (const status of change.value?.statuses ?? []) {
    if (!status.id) continue;
    const nextStatus = status.status === "delivered" ? "delivered" : status.status === "read" ? "read" : status.status === "failed" ? "failed" : "submitted";
    const { error: updateError } = await admin.rpc("powerhub_process_whatsapp_status", {
      p_tenant_id: tenantId,
      p_provider_message_id: status.id,
      p_status: nextStatus,
    });
    if (updateError) return res.status(503).json({ error: "database_unavailable" });
  }

  return res.status(200).json({ received: true });
}
