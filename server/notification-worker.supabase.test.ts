import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rpc: vi.fn() }));
const provider = vi.hoisted(() => ({ send: vi.fn() }));

vi.hoisted(() => { process.env.JWT_SECRET = "notification-worker-supabase-test-secret"; });
vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => ({ rpc: state.rpc }) }));
vi.mock("./tweetsms-client", () => ({ sendTweetSms: provider.send }));

import { encryptTenantCredential } from "./tenant-crypto";
import { processNotificationById } from "./notification-worker";

describe("عامل TweetSMS عبر Supabase", () => {
  beforeEach(() => {
    state.rpc.mockReset();
    provider.send.mockReset();
  });

  it("يرفض المعالجة من دون منفذ مصادق عليه ولا يستدعي قاعدة البيانات أو المزود", async () => {
    await expect(processNotificationById(11)).resolves.toMatchObject({ status: "skipped" });
    expect(state.rpc).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("يحجز الرسالة ذريا ثم يرسلها ويثبت النتيجة دون MySQL", async () => {
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    state.rpc
      .mockResolvedValueOnce({ data: [{ notification_id: 11, tenant_id: 20, recipient: "+970599000000", rendered_text: "فاتورتك جاهزة", api_endpoint: "https://tweetsms.ps", credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, sender_name: "PowerHup", attempt_number: 1, character_count: 13, segment_count: 1 }], error: null })
      .mockResolvedValueOnce({ data: [{ notification_id: 11, status: "submitted", provider_message_id: "provider-id", segment_count: 1 }], error: null });
    provider.send.mockResolvedValueOnce({ ok: true, message: "تم", providerMessageId: "provider-id" });

    await expect(processNotificationById(11, 7)).resolves.toEqual({ status: "submitted", providerMessageId: "provider-id" });
    expect(state.rpc).toHaveBeenNthCalledWith(1, "powerhub_claim_sms_notification", { p_user_id: 7, p_notification_id: 11 });
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(state.rpc).toHaveBeenNthCalledWith(2, "powerhub_finish_sms_notification", expect.objectContaining({ p_success: true, p_attempt_number: 1, p_delivery_uncertain: false }));
  });

  it("يثبت الفشل بعد رفض المزود ولا يعيد محاولة الإرسال تلقائياً", async () => {
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    state.rpc
      .mockResolvedValueOnce({ data: [{ notification_id: 12, tenant_id: 20, recipient: "+970599000000", rendered_text: "فاتورتك جاهزة", api_endpoint: "https://tweetsms.ps", credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, sender_name: "PowerHup", attempt_number: 3, character_count: 13, segment_count: 1 }], error: null })
      .mockResolvedValueOnce({ data: [{ notification_id: 12, status: "failed", provider_message_id: null, segment_count: 1 }], error: null });
    provider.send.mockResolvedValueOnce({ ok: false, message: "رفض المزود" });

    await expect(processNotificationById(12, 7)).resolves.toMatchObject({ status: "failed", error: "رفض المزود" });
    expect(state.rpc).toHaveBeenNthCalledWith(2, "powerhub_finish_sms_notification", expect.objectContaining({ p_success: false, p_attempt_number: 3, p_delivery_uncertain: false }));
  });
  it("يحوّل انقطاع الشبكة/النتيجة غير المؤكدة إلى needs_review", async () => {
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    state.rpc
      .mockResolvedValueOnce({ data: [{ notification_id: 13, tenant_id: 20, recipient: "+970599000000", rendered_text: "فاتورتك جاهزة", api_endpoint: "https://tweetsms.ps", credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, sender_name: "PowerHup", attempt_number: 4, character_count: 13, segment_count: 1 }], error: null })
      .mockResolvedValueOnce({ data: [{ notification_id: 13, status: "needs_review", provider_message_id: null, segment_count: 1 }], error: null });
    provider.send.mockRejectedValueOnce(new Error("fetch failed: connection reset"));

    await expect(processNotificationById(13, 7)).resolves.toMatchObject({ status: "needs_review" });
    expect(state.rpc).toHaveBeenNthCalledWith(2, "powerhub_finish_sms_notification", expect.objectContaining({ p_success: false, p_attempt_number: 4, p_delivery_uncertain: true }));
  });

});
