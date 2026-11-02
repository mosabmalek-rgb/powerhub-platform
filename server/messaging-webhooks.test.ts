import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const query: Record<string, any> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.maybeSingle = vi.fn();
  const from = vi.fn(() => query);
  return { query, from };
});

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => ({ from: state.from }) }));
vi.mock("./tenant-crypto", () => ({
  decryptTenantCredential: vi.fn(() => JSON.stringify({ accessToken: "test-access-token", appSecret: "test-app-secret" })),
  hashWebhookVerifyToken: vi.fn(() => "expected-token-hash"),
}));
import { verifyWhatsAppWebhook } from "./messaging-webhooks";

function responseRecorder() {
  const response: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  response.status = (statusCode: number) => { response.statusCode = statusCode; return response; };
  response.type = (contentType: string) => { response.headers["Content-Type"] = contentType; return response; };
  response.send = (body?: unknown) => { response.body = body; return response; };
  response.end = (body?: unknown) => { response.body = body; return response; };
  response.sendStatus = (statusCode: number) => { response.statusCode = statusCode; return response; };
  response.setHeader = (name: string, value: string) => { response.headers[name] = value; return response; };
  return response;
}

describe("WhatsApp webhook verification", () => {
  beforeEach(() => {
    state.from.mockClear();
    state.query.select.mockClear();
    state.query.eq.mockClear();
    state.query.maybeSingle.mockReset().mockResolvedValue({
      data: { webhook_verify_token_hash: "expected-token-hash" },
      error: null,
    });
  });

  it("returns the provider challenge as plain text, never as HTML", async () => {
    const challenge = "<script>alert(1)</script>";
    const req = {
      params: { tenantId: "20" },
      query: { "hub.mode": "subscribe", "hub.verify_token": "verified-token", "hub.challenge": challenge },
    } as never;
    const res = responseRecorder();

    await verifyWhatsAppWebhook(req, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/plain; charset=utf-8");
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.toString("utf8")).toBe(challenge);
  });

});
