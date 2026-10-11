// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BillingPage from "./BillingPage";
import FlexiblePermissionsPanel from "@/components/FlexiblePermissionsPanel";
import MessagingSettingsPage from "./MessagingSettingsPage";
import MeterReadingsPage from "./MeterReadingsPage";
import BulkReadingEntry from "@/components/BulkReadingEntry";
import NetworkDirectoryPage from "./NetworkDirectoryPage";
import OperationsPage from "./OperationsPage";
import SettingsPage from "./SettingsPage";
import SubscriberPortalSettingsPage from "./SubscriberPortalSettingsPage";

const mocks = vi.hoisted(() => {
  const queryCache = new Map<string, { data: unknown; isLoading: boolean; isFetching: boolean }>();
  return {
  activeRole: "viewer",
  location: "/readings",
  site: { id: 1, name: "محطة الاختبار", code: "TEST-01" },
  user: { id: 1, role: "owner", platformRole: "platform_owner", accountStatus: "active" },
  portalSettings: { portalCode: "test-portal", displayName: "بوابة الاختبار", primaryColor: "#0D1117", accentColor: "#F5B800", isEnabled: true },
  subscribers: [] as any[],
  invoices: [] as Array<{ id: number; invoiceNo: string; billingPeriod: string; consumptionKwh: string; balanceDue: string; status: string }>,
  notifications: [] as any[],
  bulkInvoiceSends: [] as any[],
  bulkInvoiceSendDetails: { items: [] as any[] },
  payments: [] as any[],
  createShareLink: vi.fn(),
  createSubscriberMutate: vi.fn(),
  createGeneratorMutate: vi.fn(),
  createReadingMutate: vi.fn(),
  createReadingMutateAsync: vi.fn(async () => ({ status: "approved", readingId: 900, invoiceId: 901 })),
  sendDeferredInvoices: vi.fn(),
  sendPendingSms: vi.fn(),
  sendBulkInvoiceSms: vi.fn(),
  retryFailedInvoiceNotification: vi.fn(),
  retryFailedInvoiceNotifications: vi.fn(),
    sendPaymentReceiptSms: vi.fn(),
  sendPaymentReminderSms: vi.fn(),
  mutation: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
  query: (data: unknown = []) => {
    const key = JSON.stringify(data);
    const cached = queryCache.get(key);
    if (cached) return cached;
    const result = { data, isLoading: false, isFetching: false, isSuccess: true, isError: false };
    queryCache.set(key, result);
    return result;
  },
};
});

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: true, loading: false, user: mocks.user }) }));
vi.mock("@/components/DashboardLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/ui/switch", () => ({ Switch: ({ checked, onCheckedChange, ...props }: { checked: boolean; onCheckedChange: (value: boolean) => void; [key: string]: unknown }) => <button type="button" aria-pressed={checked} onClick={() => onCheckedChange(!checked)} {...props} /> }));
vi.mock("qrcode.react", () => ({ QRCodeCanvas: ({ value }: { value: string }) => <canvas aria-label="رمز QR للرابط" data-value={value} /> }));
vi.mock("wouter", () => ({ useLocation: () => [mocks.location, vi.fn()] }));
vi.mock("@/lib/offline-reading-queue", () => ({ enqueueReading: vi.fn(), listQueuedReadings: vi.fn().mockResolvedValue([]), removeQueuedReading: vi.fn(), updateQueuedReading: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ powerhub: { sites: { list: { invalidate: vi.fn() } }, readingCycle: { get: { invalidate: vi.fn() } }, invoices: { list: { invalidate: vi.fn() }, page: { invalidate: vi.fn() } }, dashboard: { summary: { invalidate: vi.fn() } }, audit: { list: { invalidate: vi.fn() } }, subscribers: { list: { invalidate: vi.fn() }, quota: { invalidate: vi.fn() }, phoneReview: { invalidate: vi.fn() } }, generators: { list: { invalidate: vi.fn() } }, meters: { list: { invalidate: vi.fn() } }, readings: { list: { invalidate: vi.fn() }, page: { invalidate: vi.fn() } }, payments: { list: { invalidate: vi.fn() }, page: { invalidate: vi.fn() } }, expenses: { list: { invalidate: vi.fn() }, page: { invalidate: vi.fn() } }, messaging: { listConfigurations: { invalidate: vi.fn() }, smsDailyUsage: { invalidate: vi.fn() }, deliveryPolicy: { invalidate: vi.fn() }, listInvoiceTemplates: { invalidate: vi.fn() }, listPaymentReceiptTemplates: { invalidate: vi.fn() } }, notifications: { list: { invalidate: vi.fn() }, countDueInvoiceNotifications: { invalidate: vi.fn() }, listFailedSms: { invalidate: vi.fn() }, listBulkInvoiceSends: { invalidate: vi.fn() }, bulkInvoiceSendDetails: { invalidate: vi.fn() } }, collectorSessions: { list: { invalidate: vi.fn() }, current: { invalidate: vi.fn() } }, staff: { list: { invalidate: vi.fn() }, archived: { invalidate: vi.fn() }, allowedSubaccountRoles: { invalidate: vi.fn() }, activity: { invalidate: vi.fn() }, customRoles: { invalidate: vi.fn() } }, subscriberPortal: { settings: { invalidate: vi.fn() }, list: { invalidate: vi.fn() }, theme: { invalidate: vi.fn() } } } }),
    powerhub: {
      sites: { list: { useQuery: () => mocks.query([mocks.site]) }, branchPolicy: { useQuery: () => mocks.query({ isEnabled: false }) }, anomalyAlert: { useQuery: () => mocks.query({ anomalyAlertPercent: 50 }) }, create: { useMutation: mocks.mutation }, updateAnomalyAlert: { useMutation: mocks.mutation } },
      reportBranding: { get: { useQuery: () => mocks.query({ companyName: "PowerHub", logoUrl: null }) }, update: { useMutation: mocks.mutation } },
      readingCycle: { get: { useQuery: () => mocks.query({ cycleType: "MONTHLY", weeklyStartDay: 7, monthlyStartDay: 1 }) }, save: { useMutation: mocks.mutation } },
      staff: { myAccess: { useQuery: () => mocks.query({ role: mocks.activeRole }) }, directory: { useQuery: () => mocks.query([]) }, list: { useQuery: () => mocks.query([]) }, archived: { useQuery: () => mocks.query([]) }, allowedSubaccountRoles: { useQuery: () => mocks.query({ roles: ["manager", "accountant", "collector", "technician", "viewer"] }) }, assign: { useMutation: mocks.mutation }, archive: { useMutation: mocks.mutation }, restore: { useMutation: mocks.mutation }, setActive: { useMutation: mocks.mutation }, suspend: { useMutation: mocks.mutation }, clearSuspension: { useMutation: mocks.mutation }, create: { useMutation: mocks.mutation }, activity: { useQuery: () => mocks.query([]) }, resetPassword: { useMutation: mocks.mutation }, customRoles: { useQuery: () => mocks.query([]) }, permissionChanges: { useQuery: () => mocks.query([]) }, updatePermissions: { useMutation: mocks.mutation }, saveCustomRole: { useMutation: mocks.mutation }, deleteCustomRole: { useMutation: mocks.mutation } },
      meters: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation } },
      readings: { list: { useQuery: () => mocks.query([]) }, page: { useQuery: () => mocks.query({ items: [], hasNext: false, nextCursor: null }) }, create: { useMutation: () => ({ mutate: mocks.createReadingMutate, mutateAsync: mocks.createReadingMutateAsync, isPending: false }) }, getImage: { useMutation: mocks.mutation }, updatePending: { useMutation: mocks.mutation }, deletePending: { useMutation: mocks.mutation }, approve: { useMutation: mocks.mutation } }, mobileSync: { approveAndIssue: { useMutation: mocks.mutation } },
      tariffs: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation }, update: { useMutation: mocks.mutation } },
      invoices: { list: { useQuery: () => mocks.query(mocks.invoices) }, page: { useQuery: () => mocks.query({ items: mocks.invoices, hasNext: false, nextCursor: null }) }, createFromReading: { useMutation: mocks.mutation }, createShareLink: { useMutation: () => ({ mutate: mocks.createShareLink, isPending: false }) } },
      subscribers: { list: { useQuery: () => mocks.query(mocks.subscribers) }, quota: { useQuery: () => mocks.query({ limit: 100, currentCount: mocks.subscribers.length, remaining: 100 - mocks.subscribers.length, plan: "basic" }) }, phoneReview: { useQuery: () => mocks.query([]) }, create: { useMutation: () => ({ mutate: mocks.createSubscriberMutate, isPending: false }) }, bulkImport: { useMutation: mocks.mutation }, update: { useMutation: mocks.mutation }, applyPhoneNormalization: { useMutation: mocks.mutation } },
      generators: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: () => ({ mutate: mocks.createGeneratorMutate, isPending: false }) }, update: { useMutation: mocks.mutation } },
      payments: { list: { useQuery: () => mocks.query(mocks.payments) }, page: { useQuery: () => mocks.query({ items: mocks.payments, hasNext: false, nextCursor: null }) }, create: { useMutation: mocks.mutation } },
      companyAccounts: {
        list: {
          useQuery: () => mocks.query([{
            id: 90,
            name: "كاش",
            accountType: "cash",
            phoneNumber: null,
            balance: 1000,
            linkedSites: [{ siteId: 1, siteName: "محطة الاختبار" }],
            allowPaymentDocumentation: true,
          }]),
        },
      },
      expenses: { list: { useQuery: () => mocks.query([]) }, page: { useQuery: () => mocks.query({ items: [], hasNext: false, nextCursor: null }) }, create: { useMutation: mocks.mutation } },
      dashboard: { summary: { useQuery: () => mocks.query({ financial: {} }) }, allBranchesSummary: { useQuery: () => mocks.query({ branchCount: 1, financial: {} }) }, financialOverview: { useQuery: () => mocks.query({ outstanding: { total: 0, overdue: 0, partialInvoices: 0, accountCount: 0 }, topDebtors: [] }) } },
      paymentDocumentation: { access: { useQuery: () => ({ ...mocks.query({ allowed: false }), refetch: vi.fn() }) }, ownerFeature: { useMutation: mocks.mutation }, submit: { useMutation: mocks.mutation }, approve: { useMutation: mocks.mutation } },
      audit: { list: { useQuery: () => mocks.query([]) } },
      collectorSessions: { list: { useQuery: () => mocks.query([]) }, current: { useQuery: () => ({ data: undefined, isLoading: false, isFetching: false }) }, open: { useMutation: mocks.mutation }, close: { useMutation: mocks.mutation } },
      messaging: { listConfigurations: { useQuery: () => mocks.query([]) }, listScheduleRuns: { useQuery: () => mocks.query([]) }, smsQuota: { useQuery: () => mocks.query({ total: 0, used: 0, remaining: 0 }) }, smsDailyUsage: { useQuery: () => mocks.query({ points: [], total: 0, used: 0, remaining: 0 }) }, deliveryPolicy: { useQuery: () => mocks.query({ configured: true, isEnabled: true, whatsappEnabled: true, smsEnabled: true, message: "" }) }, listInvoiceTemplates: { useQuery: () => mocks.query([]) }, listPaymentReceiptTemplates: { useQuery: () => mocks.query([]) }, saveConfiguration: { useMutation: mocks.mutation }, testConnection: { useMutation: mocks.mutation }, saveInvoiceTemplate: { useMutation: mocks.mutation }, savePaymentReceiptTemplate: { useMutation: mocks.mutation }, configureInvoiceAutoSend: { useMutation: mocks.mutation }, requestSmsPackage: { useMutation: mocks.mutation } },
      subscriberPortal: { settings: { useQuery: () => mocks.query(mocks.portalSettings) }, saveSettings: { useMutation: mocks.mutation }, uploadLogo: { useMutation: mocks.mutation }, removeLogo: { useMutation: mocks.mutation } },
      notifications: { list: { useQuery: () => mocks.query(mocks.notifications) }, countDueInvoiceNotifications: { useQuery: () => mocks.query({ count: 0 }) }, listFailedSms: { useQuery: () => mocks.query([]) }, listBulkInvoiceSends: { useQuery: () => mocks.query(mocks.bulkInvoiceSends) }, bulkInvoiceSendDetails: { useQuery: () => mocks.query(mocks.bulkInvoiceSendDetails) }, retry: { useMutation: mocks.mutation }, retryFailedSmsBatch: { useMutation: mocks.mutation }, resolveSmsNeedsReview: { useMutation: mocks.mutation }, retryFailedInvoiceNotification: { useMutation: () => ({ mutate: mocks.retryFailedInvoiceNotification, isPending: false }) }, retryFailedInvoiceNotifications: { useMutation: () => ({ mutate: mocks.retryFailedInvoiceNotifications, isPending: false }) }, retryPaymentReceipt: { useMutation: mocks.mutation }, sendPaymentReceiptSms: { useMutation: () => ({ mutate: mocks.sendPaymentReceiptSms, isPending: false }) }, sendPaymentReminderSms: { useMutation: () => ({ mutate: mocks.sendPaymentReminderSms, isPending: false, variables: undefined }) }, sendBulkInvoiceSms: { useMutation: () => ({ mutate: mocks.sendBulkInvoiceSms, isPending: false }) }, sendAllEligibleInvoiceSms: { useMutation: () => ({ mutate: mocks.sendBulkInvoiceSms, isPending: false }) }, sendDeferredInvoices: { useMutation: () => ({ mutate: mocks.sendDeferredInvoices, isPending: false }) }, sendPendingSms: { useMutation: () => ({ mutate: mocks.sendPendingSms, isPending: false }) } },
    },
  },
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); mocks.createSubscriberMutate.mockClear(); mocks.createGeneratorMutate.mockClear(); mocks.createReadingMutate.mockClear(); mocks.createReadingMutateAsync.mockClear(); mocks.activeRole = "viewer"; mocks.location = "/readings"; mocks.subscribers = []; mocks.invoices = []; mocks.notifications = []; mocks.bulkInvoiceSends = []; mocks.bulkInvoiceSendDetails = { items: [] }; mocks.payments = []; mocks.createShareLink.mockReset(); mocks.sendDeferredInvoices.mockReset(); mocks.sendPendingSms.mockReset(); mocks.sendBulkInvoiceSms.mockReset(); mocks.retryFailedInvoiceNotification.mockReset(); mocks.retryFailedInvoiceNotifications.mockReset(); mocks.sendPaymentReceiptSms.mockReset(); });

describe("role guards in administration UI", () => {
  it("keeps invoice issuance automatic and hides manual issue controls from the viewer", () => {
    render(<BillingPage />);
    expect(screen.getByText(/تصدر الفاتورة تلقائياً بعد اعتماد القراءة/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /إصدار الفاتورة/ })).not.toBeInTheDocument();
  });

  it("shows the automatic invoice workflow to the accountant without a duplicate manual issue card", () => {
    mocks.activeRole = "accountant";
    render(<BillingPage />);
    expect(screen.getByText(/تصدر الفاتورة تلقائياً بعد اعتماد القراءة/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /إصدار الفاتورة/ })).not.toBeInTheDocument();
  });

  it("lets the owner select an unsent invoice and send only that selection", () => {
    mocks.activeRole = "owner";
    mocks.invoices = [
      { id: 81, invoiceNo: "PH-TEST-0081", billingPeriod: "2026-08", consumptionKwh: "12", totalAmount: "60", paidAmount: "0", balanceDue: "60", status: "issued" } as any,
      { id: 82, invoiceNo: "PH-TEST-0082", billingPeriod: "2026-08", consumptionKwh: "18", totalAmount: "90", paidAmount: "0", balanceDue: "90", status: "issued" } as any,
    ];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<BillingPage />);
    fireEvent.click(screen.getByLabelText("تحديد كل الفواتير غير المرسلة في الصفحة"));
    expect(screen.getByLabelText("تحديد الفاتورة PH-TEST-0081")).toBeChecked();
    expect(screen.getByLabelText("تحديد الفاتورة PH-TEST-0082")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /إرسال المحددة/ }));
    expect(mocks.sendBulkInvoiceSms).toHaveBeenCalledWith({ siteId: 1, invoiceIds: [81, 82] });
  });

  it("does not let failed or scheduled SMS invoices enter the ordinary bulk-send selection", () => {
    mocks.activeRole = "owner";
    mocks.invoices = [
      { id: 81, invoiceNo: "PH-TEST-0081", billingPeriod: "2026-08", consumptionKwh: "12", totalAmount: "60", paidAmount: "0", balanceDue: "60", status: "issued" } as any,
      { id: 82, invoiceNo: "PH-TEST-0082", billingPeriod: "2026-08", consumptionKwh: "18", totalAmount: "90", paidAmount: "0", balanceDue: "90", status: "issued" } as any,
    ];
    mocks.notifications = [
      { notification: { invoiceId: 81, status: "failed", scheduledAt: null } },
      { notification: { invoiceId: 82, status: "pending", scheduledAt: new Date("2099-01-01T00:00:00.000Z") } },
    ];
    render(<BillingPage />);
    expect(screen.getByLabelText("تحديد الفاتورة PH-TEST-0081")).toBeDisabled();
    expect(screen.getByLabelText("تحديد الفاتورة PH-TEST-0082")).toBeDisabled();
    expect(screen.getByLabelText("تحديد كل الفواتير غير المرسلة في الصفحة")).toBeDisabled();
    expect(screen.getByText("فشل")).toBeInTheDocument();
    expect(screen.getByText("في قائمة الانتظار")).toBeInTheDocument();
  });

  it("shows the bulk invoice delivery log with the executor and result to messaging users", () => {
    mocks.activeRole = "owner";
    mocks.bulkInvoiceSends = [{ id: 9, action: "send_deferred_invoice_notifications", createdAt: new Date("2026-08-23T09:30:00.000Z"), metadata: { requested: 5, submitted: 4, failed: 1 }, executorId: 12, executorName: "محاسب الفرع", executorEmail: "accountant@example.com" }];
    render(<BillingPage />);
    expect(screen.getByRole("heading", { name: "سجل الإرسال الجماعي" })).toBeInTheDocument();
    expect(screen.getByText("محاسب الفرع")).toBeInTheDocument();
    expect(screen.getByText("4 معالج")).toBeInTheDocument();
    expect(screen.getByText("1 متعذر")).toBeInTheDocument();
  });

  it("opens the bulk delivery details and exposes the date-range filter", () => {
    mocks.activeRole = "owner";
    mocks.bulkInvoiceSends = [{ id: 9, action: "send_deferred_invoice_notifications", createdAt: new Date("2026-08-23T09:30:00.000Z"), metadata: { requested: 1, submitted: 1, failed: 0 }, executorId: 12, executorName: "محاسب الفرع", executorEmail: "accountant@example.com" }];
    mocks.bulkInvoiceSendDetails = { items: [{ notificationId: 101, invoiceId: 81, invoiceNo: "PH-TEST-0081", totalAmount: "60", subscriberName: "أحمد المشترك", channel: "sms", status: "failed", lastError: "تعذر اتصال المزود", recipient: "+970599000000" }, { notificationId: 102, invoiceId: 82, invoiceNo: "PH-TEST-0082", totalAmount: "90", subscriberName: "سارة المشترك", channel: "whatsapp", status: "delivered", lastError: null, recipient: "+970599000001" }] };
    render(<BillingPage />);
    expect(screen.getByLabelText("بداية نطاق سجل الإرسال")).toBeInTheDocument();
    expect(screen.getByLabelText("نهاية نطاق سجل الإرسال")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "محاسب الفرع" }));
    expect(screen.getByRole("heading", { name: "تفاصيل عملية الإرسال الجماعي" })).toBeInTheDocument();
    expect(screen.getByText("PH-TEST-0081")).toBeInTheDocument();
    expect(screen.getByText("أحمد المشترك")).toBeInTheDocument();
    expect(screen.getByText("غير مرسلة")).toBeInTheDocument();
    expect(screen.getByText("نسبة النجاح: 50%")).toBeInTheDocument();
    expect(screen.getByText("نسبة التعذر: 50%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "تقدم نجاح وفشل عملية الإرسال" })).toHaveAttribute("aria-valuenow", "50");
    fireEvent.click(screen.getByRole("button", { name: /PH-TEST-0081/ }));
    expect(mocks.createShareLink).toHaveBeenCalledWith({ siteId: 1, invoiceId: 81 });
    fireEvent.click(screen.getByRole("button", { name: "إعادة إرسال SMS" }));
    expect(mocks.retryFailedInvoiceNotification).toHaveBeenCalledWith({ siteId: 1, notificationId: 101 });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "إعادة إرسال SMS الفاشل (1)" }));
    expect(mocks.retryFailedInvoiceNotifications).toHaveBeenCalledWith({ siteId: 1, notificationIds: [101] });
  });

  it("counts only failed SMS messages for the bulk SMS retry action", () => {
    mocks.activeRole = "owner";
    mocks.bulkInvoiceSends = [{ id: 15, action: "send_invoice_sms_batch", createdAt: new Date("2026-08-24T09:30:00.000Z"), metadata: { requested: 2, submitted: 0, failed: 2 }, executorId: 12, executorName: "محاسب الفرع", executorEmail: "accountant@example.com" }];
    mocks.bulkInvoiceSendDetails = { items: [
      { notificationId: 101, invoiceId: 81, invoiceNo: "PH-TEST-0081", totalAmount: "60", subscriberName: "أحمد المشترك", channel: "sms", status: "failed", lastError: "تعذر SMS", recipient: "+970599000000" },
      { notificationId: 103, invoiceId: 82, invoiceNo: "PH-TEST-0082", totalAmount: "90", subscriberName: "سارة المشترك", channel: "whatsapp", status: "failed", lastError: "تعذر WhatsApp", recipient: "+970599000001" },
    ] };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<BillingPage />);
    fireEvent.click(screen.getByRole("button", { name: "محاسب الفرع" }));
    const retrySms = screen.getByRole("button", { name: "إعادة إرسال SMS الفاشل (1)" });
    expect(retrySms).toBeInTheDocument();
    fireEvent.click(retrySms);
    expect(mocks.retryFailedInvoiceNotifications).toHaveBeenCalledWith({ siteId: 1, notificationIds: [101] });
  });

  it("submits a new subscriber with normalized form fields through the real mutation path", async () => {
    mocks.activeRole = "owner";
    mocks.createSubscriberMutate.mockImplementation((input: unknown) => {
      expect(input).toMatchObject({ siteId: 1, fullName: "مشترك تجريبي", phone: "0599000000", subscriptionType: "residential", serviceStatus: "active", openingReadingApproved: false });
    });
    render(<NetworkDirectoryPage kind="subscribers" />);
    fireEvent.click(screen.getByRole("button", { name: "فتح البطاقة" }));
    fireEvent.change(screen.getByLabelText("الاسم"), { target: { value: "مشترك تجريبي" } });
    fireEvent.change(screen.getByLabelText("رقم الجوال"), { target: { value: "0599000000" } });
    fireEvent.click(screen.getByRole("button", { name: "إضافة المشترك" }));
    await waitFor(() => expect(mocks.createSubscriberMutate).toHaveBeenCalledTimes(1));
  });

  it("submits a new generator through the real create mutation path", async () => {
    mocks.activeRole = "technician";
    mocks.createGeneratorMutate.mockImplementation((input: unknown) => {
      expect(input).toMatchObject({ siteId: 1, code: "GEN-TEST-01", name: "مولد اختبار", fuelType: "diesel" });
    });
    render(<NetworkDirectoryPage kind="generators" />);
    fireEvent.change(screen.getByLabelText("رمز المولد"), { target: { value: "GEN-TEST-01" } });
    fireEvent.change(screen.getByLabelText("الاسم"), { target: { value: "مولد اختبار" } });
    fireEvent.click(screen.getByRole("button", { name: "إضافة المولد" }));
    await waitFor(() => expect(mocks.createGeneratorMutate).toHaveBeenCalledTimes(1));
  });

  it("validates the reading form before calling the create mutation", async () => {
    mocks.activeRole = "owner";
    render(<MeterReadingsPage />);
    fireEvent.click(screen.getByRole("button", { name: /حفظ القراءة واعتمادها/ }));
    expect(await screen.findByText("اختر المشترك قبل حفظ القراءة.")).toBeInTheDocument();
    expect(mocks.createReadingMutateAsync).not.toHaveBeenCalled();
  });

  it("previews and submits valid bulk readings through the create mutation", async () => {
    mocks.activeRole = "owner";
    mocks.subscribers = [{ id: 77, fullName: "مشترك جماعي", subscriberNo: "PH-BULK-77", phone: "+970599000077", serviceStatus: "active" }];
    render(<BulkReadingEntry siteId={1} subscribers={mocks.subscribers} readings={[]} onSaved={async () => {}} />);
    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "PH-BULK-77" } });
    fireEvent.change(inputs[1], { target: { value: "12.52" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ القراءات السليمة" }));
    await waitFor(() => expect(mocks.createReadingMutateAsync).toHaveBeenCalledTimes(1));
    expect(mocks.createReadingMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ siteId: 1, subscriberId: 77, readingValue: "12.52" }));
  });

  it("collapses the add-subscriber card by default and opens it on request", () => {
    mocks.activeRole = "owner";
    render(<NetworkDirectoryPage kind="subscribers" />);
    expect(screen.getByText("إضافة مشترك")).toHaveClass("font-extrabold");
    expect(screen.getByRole("button", { name: "فتح البطاقة" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "إضافة المشترك" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "فتح البطاقة" }));
    expect(screen.getByRole("button", { name: "طي البطاقة" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إضافة المشترك" })).toBeInTheDocument();
  });

  it("renders the subscriber directory in read-only mode for the viewer", () => {
    mocks.subscribers = [{ id: 101, fullName: "مشترك الاختبار", subscriberNo: "PH-TEST-ABC123", phone: "+970700000000", subscriptionType: "residential", serviceStatus: "active" }];
    render(<NetworkDirectoryPage kind="subscribers" />);
    expect(screen.getByText(/وضع القراءة فقط لهذه المحطة/)).toBeInTheDocument();
    expect(screen.getByText("إرشاد بوابة الاستعلامات للمشترك")).toBeInTheDocument();
    expect(screen.getByText(/الرقم المرجعي مع رقم هاتفه الدولي المسجل/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "نسخ الرقم المرجعي" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /إضافة المشترك/ })).not.toBeInTheDocument();
  });

  it("shows generator creation to the technician but keeps it read-only for the accountant", () => {
    mocks.activeRole = "technician";
    const { unmount } = render(<NetworkDirectoryPage kind="generators" />);
    expect(screen.getByRole("button", { name: "إضافة المولد" })).toBeInTheDocument();
    unmount();
    mocks.activeRole = "accountant";
    render(<NetworkDirectoryPage kind="generators" />);
    expect(screen.getByText(/وضع القراءة فقط لهذه المحطة/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "إضافة المولد" })).not.toBeInTheDocument();
  });

  it("hides tenant messaging configuration from every non-owner role", () => {
    mocks.activeRole = "manager";
    render(<MessagingSettingsPage />);
    expect(screen.getByText(/تحتاج إلى صلاحية/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /حفظ إعداد WhatsApp/ })).not.toBeInTheDocument();
  });

  it("shows WhatsApp setup while keeping admin-managed messaging details hidden from the owner", () => {
    mocks.activeRole = "owner";
    render(<MessagingSettingsPage />);
    expect(screen.getByText("إعداد WhatsApp Cloud API")).toBeInTheDocument();
    expect(screen.queryByText("حساب TweetSMS")).not.toBeInTheDocument();
    expect(screen.queryByText("سياسة آدمن PowerHub")).not.toBeInTheDocument();
    expect(screen.getByLabelText("اسم قالب رسالة الرقم المرجعي")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /حفظ إعداد WhatsApp/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /حفظ إعداد SMS/ })).not.toBeInTheDocument();
  });

  it("shows a clear portal URL copy action to the owner", () => {
    mocks.activeRole = "owner";
    render(<SubscriberPortalSettingsPage />);
    expect(screen.getByRole("button", { name: "نسخ رابط البوابة" })).toBeInTheDocument();
    expect(screen.getByText(/انسخ الرابط ثم شاركه مع المشتركين/)).toBeInTheDocument();
    expect(screen.getByText("رمز QR للبوابة")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تنزيل رمز QR" })).toBeInTheDocument();
  });

  it("shows team administration to the owner", () => {
    mocks.activeRole = "owner";
    mocks.location = "/staff";
    render(<SettingsPage />);
    expect(screen.getByRole("button", { name: /حفظ الدور/ })).toBeInTheDocument();
  });

  it("offers the separate field-app permission to the generator owner", () => {
    render(<FlexiblePermissionsPanel siteId={1} canManageTeam staff={[{ profile: { id: 10, role: "technician", permissions: ["recordReadings"], customRoleId: null }, user: { id: 20, name: "فني الاختبار", email: "field@powerhub.test" } }]} />);
    fireEvent.change(screen.getByLabelText("اختيار الحساب لتعديل الصلاحيات"), { target: { value: "10" } });
    const fieldAppPermission = screen.getByLabelText("الدخول للتطبيق الميداني");
    expect(fieldAppPermission).not.toBeChecked();
    fireEvent.click(fieldAppPermission);
    expect(fieldAppPermission).toBeChecked();
  });

  it("keeps the operational reading entry view read-only for the viewer", () => {
    render(<OperationsPage section="readings" />);
    expect(screen.getByText(/لا يتيح دورك تنفيذ هذه العملية/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /حفظ القراءة/ })).not.toBeInTheDocument();
  });

  it("hides payment entry from the viewer in the operational collections view", () => {
    render(<OperationsPage section="collections" />);
    expect(screen.getByText(/دورك يتيح مراجعة التحصيلات فقط/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /تسجيل الدفعة/ })).not.toBeInTheDocument();
  });

  it("shows payment entry to the collector", () => {
    mocks.activeRole = "collector";
    render(<OperationsPage section="collections" />);
    expect(screen.getByRole("button", { name: /تسجيل الدفعة/ })).toBeInTheDocument();
  });

  it("shows expense entry to the accountant but keeps it read-only for the collector", () => {
    mocks.activeRole = "accountant";
    const { unmount } = render(<OperationsPage section="expenses" />);
    expect(screen.getByRole("button", { name: "حفظ المصروف" })).toBeInTheDocument();
    unmount();
    mocks.activeRole = "collector";
    render(<OperationsPage section="expenses" />);
    expect(screen.queryByRole("button", { name: "حفظ المصروف" })).not.toBeInTheDocument();
  });

  it("shows the collector session opening flow to the collector", () => {
    mocks.activeRole = "collector";
    render(<OperationsPage section="collections" />);
    expect(screen.getByText(/افتح جلسة قبل تسجيل دفعاتك الميدانية/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "فتح جلسة تحصيل" })).toBeInTheDocument();
  });

  it("shows receipt print, WhatsApp, and SMS actions for a partial payment", () => {
    mocks.activeRole = "owner";
    mocks.invoices = [{ id: 50, invoiceNo: "INV-PARTIAL", billingPeriod: "2026-08", consumptionKwh: "5", totalAmount: "100", paidAmount: "40", balanceDue: "60", status: "partially_paid" } as any];
    mocks.payments = [{ payment: { id: 70, invoiceId: 50, paymentNo: "PAY-PARTIAL", amount: "40", paymentMethod: "cash", paidAt: new Date("2026-08-20") }, subscriber: { fullName: "مشترك اختبار", phone: "970599000000" }, invoiceNo: "INV-PARTIAL" }];
    render(<OperationsPage section="collections" />);
    expect(screen.getByRole("button", { name: "طباعة" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "WhatsApp" }));
    expect(mocks.sendPaymentReceiptSms).toHaveBeenCalledWith({ siteId: 1, paymentId: 70, channel: "whatsapp" });
    fireEvent.click(screen.getByRole("button", { name: "SMS" }));
    expect(mocks.sendPaymentReceiptSms).toHaveBeenCalledWith({ siteId: 1, paymentId: 70, channel: "sms" });
  });

  it("lets an accountant create a public share link from an issued invoice in the invoice center", () => {
    mocks.activeRole = "accountant";
    mocks.invoices = [{ id: 44, invoiceNo: "PH-TEST-0044", billingPeriod: "2026-08", consumptionKwh: "50", totalAmount: "75", paidAmount: "0", balanceDue: "75", status: "issued", issueDate: new Date().toISOString(), cycleStartAt: null } as any];
    render(<BillingPage />);
    fireEvent.click(screen.getByRole("button", { name: /إرسال رابط الفاتورة/ }));
    expect(mocks.createShareLink).toHaveBeenCalledWith({ siteId: 1, invoiceId: 44 });
  });

  it("keeps audit records unavailable to the collector", () => {
    mocks.activeRole = "collector";
    render(<OperationsPage section="audit" />);
    expect(screen.getByText(/لا يتيح دورك تنفيذ هذه العملية/)).toBeInTheDocument();
  });

  it("shows audit records to the owner", () => {
    mocks.activeRole = "owner";
    render(<OperationsPage section="audit" />);
    expect(screen.getByRole("heading", { name: "سجل التدقيق" })).toBeInTheDocument();
  });

  it("shows the focused add-reading page without legacy meter forms to the viewer", () => {
    render(<MeterReadingsPage />);
    expect(screen.getByRole("heading", { name: "إضافة قراءة" })).toBeInTheDocument();
    expect(screen.queryByText("إضافة عداد")).not.toBeInTheDocument();
    expect(screen.queryByText("تسجيل قراءة جديدة")).not.toBeInTheDocument();
  });

  it("keeps platform-reading entry hidden from technicians without invoice permissions and directs them to the field tab", () => {
    mocks.activeRole = "technician";
    render(<MeterReadingsPage />);
    expect(screen.getByRole("heading", { name: "إضافة قراءة" })).toBeInTheDocument();
    expect(screen.getByText(/يتطلب صلاحيات تسجيل القراءة واعتمادها وإصدار الفاتورة/)).toBeInTheDocument();
    expect(screen.queryByText("تسجيل قراءة")).not.toBeInTheDocument();
    expect(screen.queryByText("إدخال قراءات جماعي")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /سجل القراءات/ })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "بحث القراءات" })).toBeInTheDocument();
    expect(screen.queryByText("إضافة عداد")).not.toBeInTheDocument();
  });

  it("shows platform-reading entry to an accountant with approval and invoice permissions", () => {
    mocks.activeRole = "accountant";
    render(<MeterReadingsPage />);
    expect(screen.getByText("تسجيل قراءة")).toBeInTheDocument();
    expect(screen.getByText("إدخال قراءات جماعي")).toBeInTheDocument();
    expect(screen.queryByText(/يتطلب صلاحيات تسجيل القراءة واعتمادها وإصدار الفاتورة/)).not.toBeInTheDocument();
  });
});
