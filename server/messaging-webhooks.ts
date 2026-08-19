import crypto from "node:crypto";
import type { Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { notificationMessages, tenantMessagingConfigurations } from "../drizzle/schema";
import { getDb } from "./db";
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
  const db = await getDb();
  const [configuration] = db ? await db.select({ hash: tenantMessagingConfigurations.webhookVerifyTokenHash }).from(tenantMessagingConfigurations).where(and(eq(tenantMessagingConfigurations.tenantId, tenantId), eq(tenantMessagingConfigurations.channel, "whatsapp"), eq(tenantMessagingConfigurations.isActive, true))).limit(1) : [];
  if (!configuration?.hash || !crypto.timingSafeEqual(Buffer.from(configuration.hash), Buffer.from(hashWebhookVerifyToken(token)))) return res.sendStatus(403);
  return res.status(200).send(challenge);
}

export async function receiveWhatsAppWebhook(req: RawRequest, res: Response) {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isInteger(tenantId)) return res.sendStatus(404);
  const db = await getDb();
  if (!db) return res.status(503).json({ error: "database_unavailable" });
  const [configuration] = await db.select().from(tenantMessagingConfigurations).where(and(eq(tenantMessagingConfigurations.tenantId, tenantId), eq(tenantMessagingConfigurations.channel, "whatsapp"), eq(tenantMessagingConfigurations.isActive, true))).limit(1);
  if (!configuration?.credentialCiphertext || !configuration.credentialIv) return res.sendStatus(403);
  const credential = readCredential(configuration.credentialCiphertext, configuration.credentialIv);
  const signature = typeof req.headers["x-hub-signature-256"] === "string" ? req.headers["x-hub-signature-256"] : undefined;
  if (!verifySignature(req.rawBody, signature, credential.appSecret)) return res.sendStatus(403);
  const changes = (req.body?.entry ?? []).flatMap((entry: { changes?: WhatsAppChange[] }) => entry.changes ?? []);
  for (const change of changes) for (const status of change.value?.statuses ?? []) {
    if (!status.id) continue;
    const nextStatus = status.status === "delivered" ? "delivered" : status.status === "read" ? "read" : status.status === "failed" ? "failed" : "submitted";
    await db.update(notificationMessages).set({ status: nextStatus }).where(and(eq(notificationMessages.tenantId, tenantId), eq(notificationMessages.providerMessageId, status.id)));
  }
  return res.status(200).json({ received: true });
}
