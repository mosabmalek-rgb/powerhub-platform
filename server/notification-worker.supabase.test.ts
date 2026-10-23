import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
const provider = vi.hoisted(() => ({ send: vi.fn(), balance: vi.fn() }));

vi.hoisted(() => { process.env.JWT_SECRET = "notification-worker-supabase-test-secret"; });
vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => ({ rpc: state.rpc, from: state.from }) }));
vi.mock("./powerhub-supabase", () => ({ writeSupabaseAudit: vi.fn() }));
vi.mock("./tweetsms-client", () => ({ sendTweetSms: provider.send, checkTweetSmsBalance: provider.balance }));

import { encryptTenantCredential } from "./tenant-crypto";
import { countUnconfirmedNeedsReviewPersistence, countUnpersistedNeedsReview, effectiveNeedsReviewCount, processAutomaticMaintenanceAlertEvaluation, processAutomaticUnifiedNotifications, processNotificationById } from "./notification-worker";


describe("Periodic preventive-maintenance alert evaluation", () => {
  beforeEach(() => {
    state.rpc.mockReset();
    state.from.mockReset();
    provider.send.mockReset();
    provider.balance.mockReset();
  });

  it("skips the maintenance evaluator in Preview unless explicitly opted in", async () => {
    const previousVercelEnv = process.env.VERCEL_ENV;
    const previousOptIn = process.env.POWERHUB_ALLOW_PREVIEW_MAINTENANCE_ALERTS;
    process.env.VERCEL_ENV = "preview";
    delete process.env.POWERHUB_ALLOW_PREVIEW_MAINTENANCE_ALERTS;

    try {
      await expect(processAutomaticMaintenanceAlertEvaluation()).resolves.toEqual({
        skipped: true,
        alertsEvaluated: 0,
        notificationsCreated: 0,
      });
      expect(state.rpc).not.toHaveBeenCalled();
      expect(provider.send).not.toHaveBeenCalled();
    } finally {
      if (previousVercelEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = previousVercelEnv;
      if (previousOptIn === undefined) delete process.env.POWERHUB_ALLOW_PREVIEW_MAINTENANCE_ALERTS;
      else process.env.POWERHUB_ALLOW_PREVIEW_MAINTENANCE_ALERTS = previousOptIn;
    }
  });

  it("invokes the global evaluator through the service-role RPC and counts created in-app alerts", async () => {
    const previousVercelEnv = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "production";
    state.rpc.mockResolvedValueOnce({
      data: [
        { notification_created: true },
        { notification_created: false },
        { notification_created: true },
      ],
      error: null,
    });

    try {
      await expect(processAutomaticMaintenanceAlertEvaluation()).resolves.toEqual({
        skipped: false,
        alertsEvaluated: 3,
        notificationsCreated: 2,
      });
      expect(state.rpc).toHaveBeenCalledTimes(1);
      expect(state.rpc).toHaveBeenCalledWith("powerhub_maintenance_evaluate_due_plans", {
        p_tenant_id: null,
        p_site_id: null,
      });
      expect(provider.send).not.toHaveBeenCalled();
    } finally {
      if (previousVercelEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = previousVercelEnv;
    }
  });

  it("does not hide evaluator failures or report a successful scheduled pass", async () => {
    const previousVercelEnv = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "production";
    state.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "42883", message: "function lookup failure" },
    });

    try {
      await expect(processAutomaticMaintenanceAlertEvaluation()).rejects.toThrow(
        "تعذر تقييم تنبيهات الصيانة الوقائية المجدولة.",
      );
      expect(state.rpc).toHaveBeenCalledWith("powerhub_maintenance_evaluate_due_plans", {
        p_tenant_id: null,
        p_site_id: null,
      });
      expect(provider.send).not.toHaveBeenCalled();
    } finally {
      if (previousVercelEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = previousVercelEnv;
    }
  });
});

describe("عامل TweetSMS عبر Supabase", () => {
  beforeEach(() => {
    state.rpc.mockReset();
    state.from.mockReset();
    provider.send.mockReset();
    provider.balance.mockReset();
  });

  it("counts only uncertain outcomes whose needs_review state was not persisted", () => {
    const results = [
      { status: "needs_review", reviewPersistenceState: "persisted" as const },
      { status: "needs_review", reviewPersistenceState: "not_persisted" as const },
      { status: "needs_review", reviewPersistenceState: "unknown" as const },
      { status: "failed" },
    ];
    expect(countUnpersistedNeedsReview(results)).toBe(1);
    expect(countUnconfirmedNeedsReviewPersistence(results)).toBe(2);
    expect(effectiveNeedsReviewCount(3, results)).toBe(4);
    expect(effectiveNeedsReviewCount("invalid", results)).toBe(1);
  });

  it("blocks real SMS dispatch in Vercel Preview before claiming a database row", async () => {
    const oldVercelEnv = process.env.VERCEL_ENV;
    const oldAllowPreviewSms = process.env.POWERHUB_ALLOW_PREVIEW_SMS;
    process.env.VERCEL_ENV = "preview";
    delete process.env.POWERHUB_ALLOW_PREVIEW_SMS;
    try {
      await expect(processNotificationById(12, 7)).resolves.toMatchObject({
        status: "skipped",
        error: expect.stringContaining("معطل في بيئة المعاينة"),
      });
      expect(state.rpc).not.toHaveBeenCalled();
      expect(provider.send).not.toHaveBeenCalled();
      expect(provider.balance).not.toHaveBeenCalled();
    } finally {
      if (oldVercelEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = oldVercelEnv;
      if (oldAllowPreviewSms === undefined) delete process.env.POWERHUB_ALLOW_PREVIEW_SMS;
      else process.env.POWERHUB_ALLOW_PREVIEW_SMS = oldAllowPreviewSms;
    }
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
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: [{ notification_id: 11, status: "submitted", provider_message_id: "provider-id", segment_count: 1 }], error: null });
    provider.balance.mockResolvedValueOnce({ ok: true, balance: 100 }).mockResolvedValueOnce({ ok: true, balance: 99 });
    provider.send.mockResolvedValueOnce({ ok: true, message: "تم", providerMessageId: "provider-id" });

    await expect(processNotificationById(11, 7)).resolves.toEqual({ status: "submitted", providerMessageId: "provider-id" });
    expect(state.rpc).toHaveBeenNthCalledWith(1, "powerhub_claim_sms_notification", { p_user_id: 7, p_notification_id: 11 });
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(state.rpc).toHaveBeenNthCalledWith(3, "powerhub_finish_sms_notification", expect.objectContaining({ p_success: true, p_attempt_number: 1 }));
  });

  it("يثبت الفشل بعد رفض المزود ولا يعاود محاولة الإرسال تلقائياً", async () => {
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    state.rpc
      .mockResolvedValueOnce({ data: [{ notification_id: 12, tenant_id: 20, recipient: "+970599000000", rendered_text: "فاتورتك جاهزة", api_endpoint: "https://tweetsms.ps", credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, sender_name: "PowerHup", attempt_number: 3, character_count: 13, segment_count: 1 }], error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: [{ notification_id: 12, status: "failed", provider_message_id: null, segment_count: 1 }], error: null });
    provider.balance.mockResolvedValueOnce({ ok: true, balance: 100 });
    provider.send.mockResolvedValueOnce({ ok: false, message: "رفض المزود" });

    await expect(processNotificationById(12, 7)).resolves.toMatchObject({ status: "failed", error: "رفض المزود" });
    expect(state.rpc).toHaveBeenNthCalledWith(3, "powerhub_finish_sms_notification", expect.objectContaining({ p_success: false, p_attempt_number: 3 }));
  });

  it("يحمي replay من إرسال المزود مرتين لنفس الإشعار", async () => {
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    state.rpc
      .mockResolvedValueOnce({ data: [{ notification_id: 13, tenant_id: 20, recipient: "+970599000000", rendered_text: "تنبيه", api_endpoint: "https://tweetsms.ps", credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, sender_name: "PowerHub", attempt_number: 1, character_count: 6, segment_count: 1 }], error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: [{ notification_id: 13, status: "submitted" }], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    provider.balance.mockResolvedValueOnce({ ok: true, balance: 10 }).mockResolvedValueOnce({ ok: true, balance: 9 });
    provider.send.mockResolvedValueOnce({ ok: true, providerMessageId: "provider-13" });

    await expect(processNotificationById(13, 7)).resolves.toMatchObject({ status: "submitted" });
    await expect(processNotificationById(13, 7)).resolves.toMatchObject({ status: "skipped" });
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it("يعزل الرسالة للمراجعة إذا قُبلت لدى المزود وفشل finish RPC", async () => {
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    state.rpc
      .mockResolvedValueOnce({ data: [{ notification_id: 14, tenant_id: 20, recipient: "+970599000000", rendered_text: "تنبيه", api_endpoint: "https://tweetsms.ps", credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, sender_name: "PowerHub", attempt_number: 1, character_count: 6, segment_count: 1 }], error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: [], error: new Error("finish failed") })
      .mockResolvedValueOnce({ data: [{ notification_id: 14, status: "needs_review", attempt_number: 1 }], error: null });
    provider.balance.mockResolvedValueOnce({ ok: true, balance: 10 }).mockResolvedValueOnce({ ok: true, balance: 9 });
    provider.send.mockResolvedValueOnce({ ok: true, providerMessageId: "provider-14" });

    await expect(processNotificationById(14, 7)).resolves.toMatchObject({ status: "needs_review" });
    expect(state.rpc).toHaveBeenNthCalledWith(4, "powerhub_mark_sms_needs_review", expect.objectContaining({ p_notification_id: 14, p_attempt_number: 1 }));
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it("يعزل رسالة قبلها المزود عندما يفشل فحص الرصيد اللاحق ولا يصنفها فاشلة قابلة لإعادة الإرسال", async () => {
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    state.rpc
      .mockResolvedValueOnce({ data: [{ notification_id: 15, tenant_id: 20, recipient: "+970599000000", rendered_text: "تنبيه", api_endpoint: "https://tweetsms.ps", credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, sender_name: "PowerHub", attempt_number: 1, character_count: 6, segment_count: 1 }], error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: [{ notification_id: 15, status: "needs_review", attempt_number: 1 }], error: null });
    provider.balance.mockResolvedValueOnce({ ok: true, balance: 10 }).mockResolvedValueOnce({ ok: false, balance: undefined });
    provider.send.mockResolvedValueOnce({ ok: true, providerMessageId: "provider-15" });

    await expect(processNotificationById(15, 7)).resolves.toMatchObject({ status: "needs_review" });
    expect(state.rpc).toHaveBeenCalledWith("powerhub_mark_sms_needs_review", expect.objectContaining({ p_notification_id: 15, p_provider_message_id: "provider-15" }));
    expect(state.rpc).not.toHaveBeenCalledWith("powerhub_finish_sms_notification", expect.anything());
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it("يعزل نتيجة timeout بعد بدء طلب المزود ولا يحولها إلى فشل قابل للتكرار", async () => {
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    state.rpc
      .mockResolvedValueOnce({ data: [{ notification_id: 16, tenant_id: 20, recipient: "+970599000000", rendered_text: "تنبيه", api_endpoint: "https://tweetsms.ps", credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, sender_name: "PowerHub", attempt_number: 1, character_count: 6, segment_count: 1 }], error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: [{ notification_id: 16, status: "needs_review", attempt_number: 1 }], error: null });
    provider.balance.mockResolvedValueOnce({ ok: true, balance: 10 });
    provider.send.mockRejectedValueOnce(new Error("network timeout"));

    await expect(processNotificationById(16, 7)).resolves.toMatchObject({ status: "needs_review" });
    expect(state.rpc).toHaveBeenCalledWith("powerhub_mark_sms_needs_review", expect.objectContaining({ p_notification_id: 16 }));
    expect(state.rpc).not.toHaveBeenCalledWith("powerhub_finish_sms_notification", expect.anything());
  });

  it("يعزل استجابة HTTP 200 ذات رمز TweetSMS مجهول للمراجعة بدل إعادة إرسالها", async () => {
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    state.rpc
      .mockResolvedValueOnce({ data: [{ notification_id: 17, tenant_id: 20, recipient: "+970599000000", rendered_text: "تنبيه", api_endpoint: "https://tweetsms.ps", credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, sender_name: "PowerHub", attempt_number: 1, character_count: 6, segment_count: 1 }], error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: [{ notification_id: 17, status: "needs_review", attempt_number: 1 }], error: null });
    provider.balance.mockResolvedValueOnce({ ok: true, balance: 10 });
    provider.send.mockResolvedValueOnce({ ok: false, ambiguous: true, code: 123, message: "HTTP 200: unrecognized provider status" });

    await expect(processNotificationById(17, 7)).resolves.toMatchObject({ status: "needs_review" });
    expect(state.rpc).toHaveBeenCalledWith("powerhub_mark_sms_needs_review", expect.objectContaining({ p_notification_id: 17 }));
    expect(state.rpc).not.toHaveBeenCalledWith("powerhub_finish_sms_notification", expect.anything());
    expect(provider.balance).toHaveBeenCalledTimes(1);
  });

  it("logs safe Supabase diagnostics when the unified worker cannot resolve its platform actor", async () => {
    const now = new Date("2026-10-16T12:41:00.000Z");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.rpc.mockResolvedValueOnce({ data: 0, error: null });
    state.from.mockImplementation((table: string) => {
      const query: any = {
        select() { return query; },
        eq() { return query; },
        in() { return query; },
        neq() { return query; },
        not() { return query; },
        lte() { return query; },
        order() { return query; },
        limit() { return query; },
        maybeSingle: async () => table === "users"
          ? { data: null, error: { code: "42703", message: "column platform_role does not exist; api_key=do-not-log" } }
          : { data: null, error: null },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return query;
    });

    try {
      await expect(processAutomaticUnifiedNotifications(now)).rejects.toThrow("تعذر تحديد منفذ المعالجة المركزي للمراسلات الموحدة.");
      expect(errorLog).toHaveBeenCalledWith("[notification-worker] unified platform actor lookup failed", {
        code: "42703",
        message: "column platform_role does not exist; api_key=[REDACTED]",
      });
      expect(errorLog.mock.calls.flat().join(" ")).not.toContain("do-not-log");
      expect(provider.send).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("يعالج الرسائل الموحدة المستحقة ويستثني invoice_issued والمجدولة مستقبلاً", async () => {
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    const now = new Date("2026-10-08T10:00:00.000Z");
    const pendingRows = [
      { id: 21, tenant_id: 20, subscriber_id: 301 },
      { id: 22, tenant_id: 20, subscriber_id: 302, status: "needs_review" },
    ];
    state.rpc.mockImplementation(async (name: string) => {
      if (name === "powerhub_reclaim_stale_sms_notifications") return { data: 0, error: null };
      if (name === "powerhub_claim_sms_notification") return { data: [{ notification_id: 21, tenant_id: 20, recipient: "+970599000000", rendered_text: "تم استلام الدفعة", api_endpoint: "https://tweetsms.ps", credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, sender_name: "PowerHub", attempt_number: 1, character_count: 15, segment_count: 1 }], error: null };
      if (name === "powerhub_mark_sms_provider_request_started") return { data: true, error: null };
      if (name === "powerhub_finish_sms_notification") return { data: [{ notification_id: 21, status: "submitted" }], error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    provider.balance.mockResolvedValueOnce({ ok: true, balance: 100 }).mockResolvedValueOnce({ ok: true, balance: 99 });
    provider.send.mockResolvedValueOnce({ ok: true, providerMessageId: "provider-21" });
    state.from.mockImplementation((table: string) => {
      const query: any = {
        select(value: string) { query.selection = value; return query; },
        eq(field: string, value: unknown) { (query.eqCalls ??= []).push([field, value]); return query; },
        in(field: string, value: unknown) { (query.inCalls ??= []).push([field, value]); return query; },
        neq(field: string, value: unknown) { (query.neqCalls ??= []).push([field, value]); return query; },
        not(field: string, operator: string, value: unknown) { (query.notCalls ??= []).push([field, operator, value]); return query; },
        lte(field: string, value: unknown) { (query.lteCalls ??= []).push([field, value]); return query; },
        order() { return query; }, limit() { return query; },
        maybeSingle: async () => table === "users" ? { data: { id: 7 }, error: null } : { data: null, error: null },
        insert: async () => ({ data: null, error: null }),
        then(resolve: (value: unknown) => unknown) {
          if (table === "notification_messages" && query.selection?.includes("tenant_id")) return Promise.resolve({ data: pendingRows, error: null }).then(resolve);
          if (table === "notification_messages") return Promise.resolve({ data: [{ id: 21, subscriber_id: 301 }], error: null }).then(resolve);
          if (table === "subscribers") return Promise.resolve({ data: [{ id: 301, tenant_id: 20, site_id: 30 }], error: null }).then(resolve);
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return query;
    });

    await expect(processAutomaticUnifiedNotifications(now)).resolves.toMatchObject({ scanned: 1, submitted: 1, failed: 0, needsReview: 0 });
    const notificationQuery = state.from.mock.results.find((entry: any) => entry.value?.selection?.includes("tenant_id"))?.value;
    expect(notificationQuery?.eqCalls).toEqual(expect.arrayContaining([
      ["channel", "sms"],
      ["status", "pending"],
    ]));
    expect(notificationQuery?.neqCalls).toEqual(expect.arrayContaining([["event_type", "invoice_issued"]]));
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it("يعالج الدفعات الداخلية بحد 50 دون Promise.all غير محدود", async () => {
    const source = await import("node:fs");
    const worker = source.readFileSync(new URL("./notification-worker.ts", import.meta.url), "utf8");
    expect(worker).toContain(".limit(200)");
    expect(worker).toContain("Array.from(new Set(notificationIds)).slice(0, 50)");
    expect(worker).not.toContain("Promise.all(Array.from(byScope");
  });


  it("passes the provider message ID when quarantining an uncertain SMS outcome", async () => {
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    state.rpc
      .mockResolvedValueOnce({ data: [{ notification_id: 18, tenant_id: 20, recipient: "+970599000000", rendered_text: "تنبيه", api_endpoint: "https://tweetsms.ps", credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, sender_name: "PowerHub", attempt_number: 1, character_count: 6, segment_count: 1 }], error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: [{ notification_id: 18, status: "needs_review", attempt_number: 1 }], error: null });
    provider.balance.mockResolvedValueOnce({ ok: true, balance: 10 });
    provider.send.mockResolvedValueOnce({ ok: false, ambiguous: true, code: 123, message: "ambiguous", providerMessageId: "provider-18" });

    await expect(processNotificationById(18, 7)).resolves.toMatchObject({ status: "needs_review" });
    expect(state.rpc).toHaveBeenCalledWith("powerhub_mark_sms_needs_review", expect.objectContaining({
      p_notification_id: 18,
      p_provider_message_id: "provider-18",
    }));
  });


  it("keeps an uncertain provider result out of the failed state when quarantine persistence fails", async () => {
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    state.rpc
      .mockResolvedValueOnce({ data: [{ notification_id: 19, tenant_id: 20, recipient: "+970599000000", rendered_text: "تنبيه", api_endpoint: "https://tweetsms.ps", credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, sender_name: "PowerHub", attempt_number: 1, character_count: 6, segment_count: 1 }], error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("quarantine response lost") });
    state.from.mockImplementation(() => {
      const query: any = {};
      query.select = vi.fn(() => query);
      query.eq = vi.fn(() => query);
      query.maybeSingle = vi.fn().mockResolvedValue({ data: { status: "processing", provider_message_id: null }, error: null });
      return query;
    });
    provider.balance.mockResolvedValueOnce({ ok: true, balance: 10 });
    provider.send.mockRejectedValueOnce(new Error("network timeout"));

    await expect(processNotificationById(19, 7)).resolves.toMatchObject({
      status: "needs_review",
      reviewPersistenceState: "not_persisted",
      error: expect.stringContaining("نتيجة الإرسال غير مؤكدة"),
    });
    expect(state.rpc).toHaveBeenNthCalledWith(3, "powerhub_mark_sms_needs_review", expect.objectContaining({ p_notification_id: 19 }));
    expect(state.rpc).not.toHaveBeenCalledWith("powerhub_finish_sms_notification", expect.anything());
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it("does not report a confirmed failure when both finish and quarantine RPCs fail after provider acceptance", async () => {
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    state.rpc
      .mockResolvedValueOnce({ data: [{ notification_id: 20, tenant_id: 20, recipient: "+970599000000", rendered_text: "تنبيه", api_endpoint: "https://tweetsms.ps", credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, sender_name: "PowerHub", attempt_number: 1, character_count: 6, segment_count: 1 }], error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: [], error: new Error("finish failed") })
      .mockResolvedValueOnce({ data: null, error: new Error("quarantine failed") });
    state.from.mockImplementation(() => {
      const query: any = {};
      query.select = vi.fn(() => query);
      query.eq = vi.fn(() => query);
      query.maybeSingle = vi.fn().mockResolvedValue({ data: { status: "processing", provider_message_id: null }, error: null });
      return query;
    });
    provider.balance.mockResolvedValueOnce({ ok: true, balance: 10 }).mockResolvedValueOnce({ ok: true, balance: 9 });
    provider.send.mockResolvedValueOnce({ ok: true, providerMessageId: "provider-20" });

    await expect(processNotificationById(20, 7)).resolves.toMatchObject({
      status: "needs_review",
      reviewPersistenceState: "not_persisted",
      error: expect.stringContaining("نتيجة التسليم غير مؤكدة"),
    });
    expect(state.rpc).toHaveBeenNthCalledWith(4, "powerhub_mark_sms_needs_review", expect.objectContaining({
      p_notification_id: 20,
      p_provider_message_id: "provider-20",
    }));
    expect(provider.send).toHaveBeenCalledTimes(1);
  });


  it("recognizes a committed review state when the RPC response is lost", async () => {
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    state.rpc
      .mockResolvedValueOnce({ data: [{ notification_id: 21, tenant_id: 20, recipient: "+970599000000", rendered_text: "تنبيه", api_endpoint: "https://tweetsms.ps", credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, sender_name: "PowerHub", attempt_number: 1, character_count: 6, segment_count: 1 }], error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("response lost after commit") });
    state.from.mockImplementation(() => {
      const query: any = {};
      query.select = vi.fn(() => query);
      query.eq = vi.fn(() => query);
      query.maybeSingle = vi.fn().mockResolvedValue({ data: { status: "needs_review", provider_message_id: "provider-21" }, error: null });
      return query;
    });
    provider.balance.mockResolvedValueOnce({ ok: true, balance: 10 });
    provider.send.mockRejectedValueOnce(new Error("network timeout"));

    await expect(processNotificationById(21, 7)).resolves.toMatchObject({ status: "needs_review", reviewPersistenceState: "persisted" });
    expect(state.from).toHaveBeenCalledWith("notification_messages");
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it("reconciles a lost finish response from the committed submitted row", async () => {
    const encrypted = encryptTenantCredential(JSON.stringify({ apiKey: "tenant-key-123" }));
    state.rpc
      .mockResolvedValueOnce({ data: [{ notification_id: 22, tenant_id: 20, recipient: "+970599000000", rendered_text: "تنبيه", api_endpoint: "https://tweetsms.ps", credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, sender_name: "PowerHub", attempt_number: 1, character_count: 6, segment_count: 1 }], error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("finish response lost after commit") })
      .mockResolvedValueOnce({ data: null, error: new Error("claim already finalized") });
    state.from.mockImplementation(() => {
      const query: any = {};
      query.select = vi.fn(() => query);
      query.eq = vi.fn(() => query);
      query.maybeSingle = vi.fn().mockResolvedValue({ data: { status: "submitted", provider_message_id: "provider-22" }, error: null });
      return query;
    });
    provider.balance.mockResolvedValueOnce({ ok: true, balance: 10 }).mockResolvedValueOnce({ ok: true, balance: 9 });
    provider.send.mockResolvedValueOnce({ ok: true, providerMessageId: "provider-22" });

    await expect(processNotificationById(22, 7)).resolves.toMatchObject({ status: "submitted", providerMessageId: "provider-22" });
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

});
