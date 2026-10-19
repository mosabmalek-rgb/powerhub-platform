// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MessagingSettingsPage from "./MessagingSettingsPage";

const state = vi.hoisted(() => ({ mutate: vi.fn(), automationMutate: vi.fn(), readiness: true, policy: { configured: true, isEnabled: true, whatsappEnabled: true, smsEnabled: true, message: "القنوات مفتوحة للتجربة" } }));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: true, loading: false }) }));
vi.mock("@/components/DashboardLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ powerhub: { messaging: { listConfigurations: { invalidate: vi.fn() }, smsDailyUsage: { invalidate: vi.fn() }, deliveryPolicy: { invalidate: vi.fn() }, listInvoiceTemplates: { invalidate: vi.fn() }, listPaymentReceiptTemplates: { invalidate: vi.fn() } }, subscribers: { list: { invalidate: vi.fn() }, phoneReview: { invalidate: vi.fn() } }, unifiedMessaging: { templates: { invalidate: vi.fn() }, automations: { invalidate: vi.fn() }, campaign: { invalidate: vi.fn() }, history: { invalidate: vi.fn() } }, notifications: { list: { invalidate: vi.fn() } }, audit: { list: { invalidate: vi.fn() } } } }),
    powerhub: {
      sites: { list: { useQuery: () => ({ data: [{ id: 3, name: "محطة الاختبار" }] }) } },
      staff: { myAccess: { useQuery: () => ({ data: { role: "owner" } }) } },
      dashboard: { financialOverview: { useQuery: () => ({ data: { month: { invoiced: 100, collectionRate: 55 }, outstanding: { overdue: 25, partialInvoices: 2 }, topDebtors: [{ subscriber: "مشترك متأخر", subscriberId: 11, invoiceId: 24, invoiceNo: "INV-24", outstanding: 25, isOverdue: true, ageDays: 7 }] } }) } },
      siteBillingPolicy: { get: { useQuery: () => ({ data: { automaticFractionDiscountEnabled: true, fractionCarryEnabled: true } }) } },
      subscribers: { list: { useQuery: () => ({ data: [{ id: 11, fullName: "مشترك الاختبار", subscriberNo: "SUB-11", phone: "+970599000000" }] }) }, phoneReview: { useQuery: () => ({ data: [{ id: 11, fullName: "مشترك قديم", phone: "00970599000000", status: "ready", normalizedPhone: "+970599000000", reason: "يمكن توحيد الصيغة تلقائياً." }] }) }, applyPhoneNormalization: { useMutation: () => ({ mutate: state.mutate, isPending: false }) } },
      unifiedMessaging: {
        templates: { useQuery: () => ({ data: [
          { id: 101, name: "قالب ترحيب", channel: "sms", isActive: true, eventType: "subscriber_created", body: "مرحباً {{subscriber_name}}" },
          { id: 102, name: "قالب تذكير", channel: "sms", isActive: true, eventType: "invoice_overdue", body: "تذكير {{invoice_no}}" },
        ] }) },
        connectionReadiness: { useQuery: () => ({ data: { ready: state.readiness, label: state.readiness ? "الربط فعال وجاهز" : "الربط غير جاهز", detail: "حالة الاختبار" }, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() }) },
        automations: { useQuery: () => ({ data: [] }) },
        history: { useQuery: () => ({ data: { items: [], total: 0, campaignCount: 0, stats: { total: 0, submitted: 0, failed: 0, pending: 0, processing: 0, needsReview: 0, campaigns: 0 }, timezone: "Asia/Gaza" }, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() }) },
        campaign: { useQuery: () => ({ data: null }) },
        saveTemplate: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
        saveAutomation: { useMutation: () => ({ mutate: state.automationMutate, isPending: false }) },
        setAutomationState: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
        sendManual: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
        retryFailed: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
        retryFailedSmsBatch: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
        resolveSmsNeedsReview: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
      },
      messaging: {
        listConfigurations: { useQuery: () => ({ data: [{ channel: "whatsapp", provider: "meta_whatsapp_cloud", phoneNumberId: "123", templateName: "invoice_ready_ar", receiptTemplateName: "payment_receipt_ar", isActive: true }] }) },
        listScheduleRuns: { useQuery: () => ({ data: [], isLoading: false }) },
        smsQuota: { useQuery: () => ({ data: { total: 100, used: 10, remaining: 90, senderName: "MouldNorth", isActive: true, configured: true, lastError: null } }) },
        smsDailyUsage: { useQuery: () => ({ data: { points: [{ date: "2026-08-20", count: 3 }, { date: "2026-08-21", count: 4 }], total: 100, used: 10, remaining: 90 }, isLoading: false }) },
        deliveryPolicy: { useQuery: () => ({ data: state.policy }) },
        listInvoiceTemplates: { useQuery: () => ({ data: [{ channel: "whatsapp", body: "أهلاً {{subscriber_name}}، فاتورتك {{invoice_no}}", isActive: true }] }) },
        listPaymentReceiptTemplates: { useQuery: () => ({ data: [{ channel: "sms", body: "إيصال {{payment_no}}؛ المبلغ {{payment_amount}}؛ المتبقي {{balance_due}}", isActive: true }] }) },
        saveConfiguration: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
        testConnection: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
        saveInvoiceTemplate: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
        savePaymentReceiptTemplate: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
        configureInvoiceAutoSend: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
        requestSmsPackage: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
      },
      notifications: {
        list: { useQuery: () => ({ data: [{ invoiceNo: "INV-01", subscriber: { fullName: "مشترك الاختبار" }, notification: { id: 8, channel: "whatsapp", recipient: "0790000000", status: "failed", attempts: 2, lastError: "رفض المزود", createdAt: new Date("2026-08-20") } }, { invoiceNo: "INV-02", subscriber: { fullName: "مشترك الاختبار" }, notification: { id: 9, invoiceId: 25, channel: "sms", recipient: "+970599000000", status: "pending", attempts: 0, scheduledAt: new Date("2026-11-01T10:00:00Z"), createdAt: new Date("2026-10-18T10:00:00Z") } }] }) },
        retry: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
        retryFailedInvoiceNotification: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
        retryPaymentReceipt: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
      },
    },
  },
}));

afterEach(() => { document.body.innerHTML = ""; state.mutate.mockReset(); state.automationMutate.mockReset(); state.readiness = true; state.policy = { configured: true, isEnabled: true, whatsappEnabled: true, smsEnabled: true, message: "القنوات مفتوحة للتجربة" }; });

describe("owner invoice messaging settings", () => {
  it("shows admin-gated channels, editable templates, and the invoice delivery log", () => {
    render(<MessagingSettingsPage />);
    expect(screen.getByText("قوالب الفاتورة وحالة الإرسال")).toBeInTheDocument();
    expect(screen.getByText("قالب فاتورة WhatsApp")).toBeInTheDocument();
    expect(screen.getByText("قالب فاتورة SMS")).toBeInTheDocument();
    expect(screen.getByText("قالب إيصال الدفع عبر SMS")).toBeInTheDocument();
    expect(screen.getByText("اسم قالب إيصال الدفع المعتمد")).toBeInTheDocument();
    expect(screen.queryByText("سياسة آدمن PowerHub")).not.toBeInTheDocument();
    expect(screen.queryByText("حساب TweetSMS")).not.toBeInTheDocument();
    expect(screen.getByText("رصيد رسائل TweetSMS")).toBeInTheDocument();
    expect(screen.getByText("MouldNorth")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Jawwal Bulk SMS/ })).not.toBeInTheDocument();
    expect(screen.getByText("سجل إرسال فواتير المشتركين")).toBeInTheDocument();
    expect(screen.getByText("سجل إرسال إيصالات الدفع")).toBeInTheDocument();
    expect(screen.getByText("مراجعة الأرقام القديمة")).toBeInTheDocument();
    expect(screen.getByText("تنبيهات التحصيل والمتأخرات")).toBeInTheDocument();
    expect(screen.getByText("متأخرات تجاوزت الاستحقاق")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "فتح الفاتورة" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تسجيل تحصيل" })).toBeInTheDocument();
    expect(screen.getByText("إجمالي الرسائل المرسلة")).toBeInTheDocument();
    expect(screen.getAllByText("رفض المزود").length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getAllByRole("button", { name: /قيمة الفاتورة/ })[0]);
    expect((document.querySelectorAll("textarea")[0] as HTMLTextAreaElement).value).toContain("{{total_amount}}");
    expect(screen.getAllByText("معاينة حية للرسالة النهائية")).toHaveLength(2);
    expect(screen.getByText(/رسالة SMS/)).toBeInTheDocument();
    fireEvent.change(document.querySelectorAll("textarea")[0], { target: { value: "مرحباً {{subscriber_name}}" } });
    expect(screen.getAllByText(/مرحباً أحمد علي/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("button", { name: "إعادة إرسال" }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("button", { name: "اختبار الاتصال" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "حفظ قالب WhatsApp" }));
    expect(state.mutate).toHaveBeenCalledWith(expect.objectContaining({ siteId: 3, channel: "whatsapp", isActive: true }));
    fireEvent.click(screen.getByRole("button", { name: "معاينة الرسالة" }));
    expect(screen.getByText("إيصال PAY-2026-0012؛ المبلغ 40.0؛ المتبقي 52.0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "حفظ قالب إيصال SMS" }));
    expect(state.mutate).toHaveBeenCalledWith(expect.objectContaining({ siteId: 3, body: "إيصال {{payment_no}}؛ المبلغ {{payment_amount}}؛ المتبقي {{balance_due}}", isActive: true }));
  });


  it("saves the automation using its own selected template and event, not the template editor state", () => {
    render(<MessagingSettingsPage />);
    const automationName = screen.getByPlaceholderText("اسم الأتمتة");
    fireEvent.change(automationName, { target: { value: "تذكير المتأخرات" } });
    fireEvent.change(screen.getByRole("combobox", { name: "قالب الأتمتة" }), { target: { value: "102" } });
    fireEvent.change(screen.getByRole("combobox", { name: "حدث الأتمتة" }), { target: { value: "invoice_overdue" } });
    expect(screen.getByRole("spinbutton", { name: "بعد كم ساعة من الاستحقاق" })).toHaveValue(24);
    expect(screen.getByRole("spinbutton", { name: "أقل رصيد مستحق" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("spinbutton", { name: "بعد كم ساعة من الاستحقاق" }), { target: { value: "36" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "أقل رصيد مستحق" }), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ الأتمتة" }));
    expect(state.automationMutate).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 3, templateId: 102, name: "تذكير المتأخرات", eventType: "invoice_overdue",
      sendType: "automatic", scheduleType: "none", triggerConfig: { afterDueHours: 36, minBalance: 25 },
    }));
  });


  it("submits a manual SMS campaign with the explicitly selected template and recipients when ready", () => {
    state.readiness = true;
    render(<MessagingSettingsPage />);
    fireEvent.change(screen.getByRole("combobox", { name: "قالب SMS للحملة اليدوية" }), { target: { value: "101" } });
    fireEvent.click(screen.getByLabelText(/مشترك الاختبار.*SUB-11/));
    fireEvent.click(screen.getByRole("button", { name: "إرسال الحملة" }));
    expect(state.mutate).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 3, templateId: 101, subscriberIds: [11], operationId: expect.any(String),
    }));
  });

  it("does not submit a manual SMS campaign when TweetSMS readiness is false", () => {
    state.readiness = false;
    render(<MessagingSettingsPage />);
    fireEvent.change(screen.getByRole("combobox", { name: "قالب SMS للحملة اليدوية" }), { target: { value: "101" } });
    fireEvent.click(screen.getByLabelText(/مشترك الاختبار.*SUB-11/));
    expect(screen.getByRole("button", { name: "إرسال الحملة" })).toBeDisabled();
    expect(state.mutate).not.toHaveBeenCalled();
  });


  it("keeps future-scheduled invoice SMS disabled until its scheduled time", () => {
    render(<MessagingSettingsPage />);
    expect(screen.getByRole("button", { name: "بانتظار الموعد" })).toBeDisabled();
  });

  it("blocks provider setup until the platform administrator explicitly opens the policy", () => {
    state.policy = { configured: false, isEnabled: true, whatsappEnabled: true, smsEnabled: true, message: "" };
    render(<MessagingSettingsPage />);
    expect(screen.getByText("حساب TweetSMS")).toBeInTheDocument();
    expect(screen.queryByText("بانتظار تهيئة الآدمن")).not.toBeInTheDocument();
    expect(screen.queryByText("قالب فاتورة WhatsApp")).not.toBeInTheDocument();
  });
});
