import { describe, expect, it, vi } from "vitest";
import { checkTweetSmsAccount, checkTweetSmsBalance, checkTweetSmsSender, sendTweetSms } from "./tweetsms-client";

const credentials = { apiKey: "test-api-key", apiSecret: "optional-token" };

describe("TweetSMS API-KEY client", () => {
  it("checks the account through the documented chk_user endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("999", { status: 200 }));
    const result = await checkTweetSmsAccount({ endpoint: "https://tweetsms.ps", credentials }, fetcher);
    expect(result).toMatchObject({ ok: true, code: 999 });
    expect(fetcher).toHaveBeenCalledWith("https://tweetsms.ps/api.php/maan/chk_user", expect.objectContaining({ method: "POST", body: "api_key=test-api-key" }));
  });

  it("uses the documented balance endpoint and optional token without exposing it in the result", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 999, balance: "82" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const result = await checkTweetSmsBalance({ endpoint: "https://tweetsms.ps/api.php/maan", credentials }, fetcher);
    expect(result).toMatchObject({ ok: true, code: 999, balance: 82 });
    expect(fetcher).toHaveBeenCalledWith("https://tweetsms.ps/api.php/maan/chk_balance", expect.objectContaining({ headers: expect.objectContaining({ "X-Auth-Token": "optional-token" }), body: expect.stringContaining("token=optional-token") }));
    expect(JSON.stringify(result)).not.toContain("optional-token");
  });

  it("checks the registered sender through senderstatus before an admin activates sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("999", { status: 200 }));
    const result = await checkTweetSmsSender({ endpoint: "https://tweetsms.ps", credentials, sender: "MouldNorth" }, fetcher);
    expect(result).toMatchObject({ ok: true, code: 999 });
    expect(fetcher).toHaveBeenCalledWith("https://tweetsms.ps/api.php/maan/senderstatus", expect.objectContaining({ body: expect.stringContaining("sendertext=MouldNorth") }));
  });

  it("submits sender, message and normalized recipient to the documented sendsms endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 999, message_id: "provider-42" }), { status: 200 }));
    const result = await sendTweetSms({ endpoint: "https://tweetsms.ps", credentials, sender: "MouldNorth", message: "فاتورتك جاهزة", recipient: "+970 59 123 4567" }, fetcher);
    expect(result).toMatchObject({ ok: true, code: 999, providerMessageId: "provider-42" });
    expect(fetcher).toHaveBeenCalledWith("https://tweetsms.ps/api.php/maan/sendsms", expect.objectContaining({ body: expect.stringContaining("sender=MouldNorth") }));
    expect((fetcher.mock.calls[0][1] as RequestInit).body).toContain("to=970591234567");
  });

  it("marks non-2xx sendsms responses as ambiguous to prevent unsafe retry", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 999, message_id: "provider-ambiguous" }), { status: 502 }));
    const result = await sendTweetSms({ endpoint: "https://tweetsms.ps", credentials, sender: "MouldNorth", message: "فاتورتك جاهزة", recipient: "970591234567" }, fetcher);
    expect(result).toMatchObject({ ok: false, ambiguous: true, providerMessageId: "provider-ambiguous" });
    expect(result.message).toContain("لم تُحسم نتيجة طلب الإرسال");
  });

  it("maps the documented low-credit status to a retryable provider failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("-124", { status: 200 }));
    const result = await sendTweetSms({ endpoint: "https://tweetsms.ps", credentials, sender: "MouldNorth", message: "فاتورتك جاهزة", recipient: "970591234567" }, fetcher);
    expect(result).toMatchObject({ ok: false, code: -124 });
    expect(result.message).toContain("رصيد");
  });
});
