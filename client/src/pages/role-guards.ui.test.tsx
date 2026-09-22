// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BillingPage from "./BillingPage";
import FlexiblePermissionsPanel from "@/components/FlexiblePermissionsPanel";
import MessagingSettingsPage from "./MessagingSettingsPage";
import MeterReadingsPage from "./MeterReadingsPage";
import NetworkDirectoryPage from "./NetworkDirectoryPage";
import OperationsPage from "./OperationsPage";
import SettingsPage from "./SettingsPage";
import SubscriberPortalSettingsPage from "./SubscriberPortalSettingsPage";

const mocks = vi.hoisted(() => ({
  activeRole: "viewer",
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
  sendDeferredInvoices: vi.fn(),
  sendPendingSms: vi.fn(),
  retryFailedInvoiceNotification: vi.fn(),
  retryFailedInvoiceNotifications: vi.fn(),
  sendPaymentReceipt: vi.fn(),
  sendPaymentReceiptSms: vi.fn(),
  sendPaymentReminderSms: vi.fn(),
  mutation: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
  query: (data: unknown = []) => ({ data, isLoading: false, isFetching: false }),
}));

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
vi.mock("wouter", () => ({ useLocation: () => ["/readings", vi.fn()] }));
vi.mock("@/lib/offline-reading-queue", () => ({ enqueueReading: vi.fn(), listQueuedReadings: vi.fn().mockResolvedValue([]), removeQueuedReading: vi.fn(), updateQueuedReading: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ powerhub: { sites: { list: { invalidate: vi.fn() } }, invoices: { list: { invalidate: vi.fn() } }, dashboard: { summary: { invalidate: vi.fn() } }, audit: { list: { invalidate: vi.fn() } }, subscribers: { list: { invalidate: vi.fn() }, quota: { invalidate: vi.fn() }, phoneReview: { invalidate: vi.fn() } }, generators: { list: { invalidate: vi.fn() } }, meters: { list: { invalidate: vi.fn() } }, readings: { list: { invalidate: vi.fn() } }, payments: { list: { invalidate: vi.fn() } }, expenses: { list: { invalidate: vi.fn() } }, messaging: { listConfigurations: { invalidate: vi.fn() }, smsDailyUsage: { invalidate: vi.fn() }, deliveryPolicy: { invalidate: vi.fn() }, listInvoiceTemplates: { invalidate: vi.fn() }, listPaymentReceiptTemplates: { invalidate: vi.fn() } }, notifications: { list: { invalidate: vi.fn() }, listBulkInvoiceSends: { invalidate: vi.fn() }, bulkInvoiceSendDetails: { invalidate: vi.fn() } }, collectorSessions: { list: { invalidate: vi.fn() }, current: { invalidate: vi.fn() } }, staff: { list: { invalidate: vi.fn() }, activity: { invalidate: vi.fn() }, customRoles: { invalidate: vi.fn() } }, subscriberPortal: { settings: { invalidate: vi.fn() }, list: { invalidate: vi.fn() }, theme: { invalidate: vi.fn() } } } }),
    powerhub: {
      sites: { list: { useQuery: () => mocks.query([mocks.site]) }, branchPolicy: { useQuery: () => mocks.query({ isEnabled: false }) }, anomalyAlert: { useQuery: () => mocks.query({ anomalyAlertPercent: 50 }) }, create: { useMutation: mocks.mutation }, updateAnomalyAlert: { useMutation: mocks.mutation } },
      reportBranding: { get: { useQuery: () => mocks.query({ companyName: "PowerHub", logoUrl: null }) }, update: { useMutation: mocks.mutation } },
      staff: { myAccess: { useQuery: () => mocks.query({ role: mocks.activeRole }) }, directory: { useQuery: () => mocks.query([]) }, list: { useQuery: () => mocks.query([]) }, allowedSubaccountRoles: { useQuery: () => mocks.query({ roles: ["manager", "accountant", "collector", "technician", "viewer"] }) }, assign: { useMutation: mocks.mutation }, setActive: { useMutation: mocks.mutation }, suspend: { useMutation: mocks.mutation }, clearSuspension: { useMutation: mocks.mutation }, create: { useMutation: mocks.mutation }, activity: { useQuery: () => mocks.query([]) }, resetPassword: { useMutation: mocks.mutation }, customRoles: { useQuery: () => mocks.query([]) }, permissionChanges: { useQuery: () => mocks.query([]) }, updatePermissions: { useMutation: mocks.mutation }, saveCustomRole: { useMutation: mocks.mutation }, deleteCustomRole: { useMutation: mocks.mutation } },
      meters: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation } },
      readings: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation }, updatePending: { useMutation: mocks.mutation }, deletePending: { useMutation: mocks.mutation }, approve: { useMutation: mocks.mutation } }, mobileSync: { approveAndIssue: { useMutation: mocks.mutation } }, tariffs: { list: { useQuery: () => mocks.query([]) } },
      tariffs: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation } },
      invoices: { list: { useQuery: () => mocks.query(mocks.invoices) }, createFromReading: { useMutation: mocks.mutation }, createShareLink: { useMutation: () => ({ mutate: mocks.createShareLink, isPending: false }) } },
      subscribers: { list: { useQuery: () => mocks.query(mocks.subscribers) }, quota: { useQuery: () => mocks.query({ limit: 100, currentCount: mocks.subscribers.length, remaining: 100 - mocks.subscribers.length, plan: "starter" }) }, phoneReview: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation }, bulkImport: { useMutation: mocks.mutation }, update: { useMutation: mocks.mutation }, applyPhoneNormalization: { useMutation: mocks.mutation } },
      generators: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation }, update: { useMutation: mocks.mutation } },
      payments: { list: { useQuery: () => mocks.query(mocks.payments) }, create: { useMutation: mocks.mutation } },
      companyAccounts: { list: { useQuery: () => mocks.query([]) } },
      expenses: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation } },
      dashboard: { summary: { useQuery: () => mocks.query({ financial: {} }) }, allBranchesSummary: { useQuery: () => mocks.query({ branchCount: 1, financial: {} }) }, financialOverview: { useQuery: () => mocks.query({ outstanding: { total: 0, overdue: 0, partialInvoices: 0, accountCount: 0 }, topDebtors: [] }) } },
      paymentDocumentation: { access: { useQuery: () => ({ ...mocks.query({ allowed: false }), refetch: vi.fn() }) }, ownerFeature: { useMutation: mocks.mutation } },
      audit: { list: { useQuery: () => mocks.query([]) } },
      collectorSessions: { list: { useQuery: () => mocks.query([]) }, current: { useQuery: () => ({ data: undefined, isLoading: false, isFetching: false }) }, open: { useMutation: mocks.mutation }, close: { useMutation: mocks.mutation } },
      messaging: { listConfigurations: { useQuery: () => mocks.query([]) }, listScheduleRuns: { useQuery: () => mocks.query([]) }, smsQuota: { useQuery: () => mocks.query({ total: 0, used: 0, remaining: 0 }) }, smsDailyUsage: { useQuery: () => mocks.query({ points: [], total: 0, used: 0, remaining: 0 }) }, deliveryPolicy: { useQuery: () => mocks.query({ configured: true, isEnabled: true, whatsappEnabled: true, smsEnabled: true, message: "" }) }, listInvoiceTemplates: { useQuery: () => mocks.query([]) }, listPaymentReceiptTemplates: { useQuery: () => mocks.query([]) }, saveConfiguration: { useMutation: mocks.mutation }, testConnection: { useMutation: mocks.mutation }, saveInvoiceTemplate: { useMutation: mocks.mutation }, savePaymentReceiptTemplate: { useMutation: mocks.mutation }, configureInvoiceAutoSend: { useMutation: mocks.mutation }, requestSmsPackage: { useMutation: mocks.mutation } },
      subscriberPortal: { settings: { useQuery: () => mocks.query(mocks.portalSettings) }, saveSettings: { useMutation: mocks.mutation }, uploadLogo: { useMutation: mocks.mutation }, removeLogo: { useMutation: mocks.mutation } },
      notifications: { list: { useQuery: () => mocks.query(mocks.notifications) }, listBulkInvoiceSends: { useQuery: () => mocks.query(mocks.bulkInvoiceSends) }, bulkInvoiceSendDetails: { useQuery: () => mocks.query(mocks.bulkInvoiceSendDetails) }, retry: { useMutation: mocks.mutation }, retryFailedInvoiceNotification: { useMutation: () => ({ mutate: mocks.retryFailedInvoiceNotification, isPending: false }) }, retryFailedInvoiceNotifications: { useMutation: () => ({ mutate: mocks.retryFailedInvoiceNotifications, isPending: false }) }, retryPaymentReceipt: { useMutation: mocks.mutation }, sendPaymentReceipt: { useMutation: () => ({ mutate: mocks.sendPaymentReceipt, isPending: false }) }, sendPaymentReceiptSms: { useMutation: () => ({ mutate: mocks.sendPaymentReceiptSms, isPending: false }) }, sendPaymentReminder: { useMutation: mocks.mutation }, sendPaymentReminderSms: { useMutation: () => ({ mutate: mocks.sendPaymentReminderSms, isPending: false, variables: undefined }) }, sendBulkInvoiceSms: { useMutation: mocks.mutation }, sendDeferredInvoices: { useMutation: () => ({ mutate: mocks.sendDeferredInvoices, isPending: false }) }, sendPendingSms: { useMutation: () => ({ mutate: mocks.sendPendingSms, isPending: false }) } },
    },
  },
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); mocks.activeRole = "viewer"; mocks.subscribers = []; mocks.invoices = []; mocks.notifications = []; mocks.bulkInvoiceSends = []; mocks.bulkInvoiceSendDetails = { items: [] }; mocks.payments = []; mocks.createShareLink.mockReset(); mocks.sendDeferredInvoices.mockReset(); mocks.sendPendingSms.mockReset(); mocks.retryFailedInvoiceNotification.mockReset(); mocks.retryFailedInvoiceNotifications.mockReset(); mocks.sendPaymentReceipt.mockReset(); mocks.sendPaymentReceiptSms.mockReset(); mocks.sendPaymentReminderSms.mockReset(); });

describe("role guards in administration UI", () => {
  it("hides invoice issuance and sharing controls from the viewer", () => {
    render(<BillingPage />);
    expect(screen.getByText(/تستطيع مراجعة الفواتير فقط/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /إصدار الفاتورة/ })).not.toBeInTheDocument();
  });

  it("shows invoice issuance controls to the accountant", () => {
    mocks.activeRole = "accountant";
    render(<BillingPage />);
    expect(screen.getByRole("button", { name: /إصدار الفاتورة/ })).toBeInTheDocument();
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
    expect(mocks.sendPendingSms).toHaveBeenCalledWith({ siteId: 1, invoiceIds: [81, 82] });
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
    expect(screen.getByText("تعذر")).toBeInTheDocument();
    expect(screen.getByText("نسبة النجاح: 50%")).toBeInTheDocument();
    expect(screen.getByText("نسبة التعذر: 50%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "تقدم نجاح وفشل عملية الإرسال" })).toHaveAttribute("aria-valuenow", "50");
    fireEvent.click(screen.getByRole("button", { name: /PH-TEST-0081/ }));
    expect(mocks.createShareLink).toHaveBeenCalledWith({ siteId: 1, invoiceId: 81 });
    fireEvent.click(screen.getByRole("button", { name: "إعادة إرسال SMS" }));
    expect(mocks.sendPendingSms).toHaveBeenCalledWith({ siteId: 1, invoiceIds: [81], includeFailed: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "إعادة إرسال SMS الفاشل (1)" }));
    expect(mocks.sendPendingSms).toHaveBeenCalledWith({ siteId: 1, invoiceIds: [81], includeFailed: true });
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

  it("shows WhatsApp setup and a read-only TweetSMS status to the owner", () => {
    mocks.activeRole = "owner";
    render(<MessagingSettingsPage />);
    expect(screen.getByText("إعداد WhatsApp Cloud API")).toBeInTheDocument();
    expect(screen.getByText("حساب TweetSMS")).toBeInTheDocument();
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

  it("lets an accountant create a public share link from an issued invoice", () => {
    mocks.activeRole = "accountant";
    mocks.invoices = [{ id: 44, invoiceNo: "PH-TEST-0044", billingPeriod: "2026-08", consumptionKwh: "50", balanceDue: "75", status: "issued" }];
    render(<OperationsPage section="invoices" />);
    fireEvent.click(screen.getByRole("button", { name: "إنشاء رابط" }));
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

  it("shows direct reading registration to the technician", () => {
    mocks.activeRole = "technician";
    render(<MeterReadingsPage />);
    expect(screen.getByRole("heading", { name: "إضافة قراءة" })).toBeInTheDocument();
    expect(screen.getByText("تسجيل قراءة")).toBeInTheDocument();
    expect(screen.getByText("آخر القراءات المسجلة")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "بحث في القراءات" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "فلترة حالة القراءة" })).toBeInTheDocument();
    expect(screen.queryByText("إضافة عداد")).not.toBeInTheDocument();
    expect(screen.queryByText("تسجيل قراءة جديدة")).not.toBeInTheDocument();
  });
});
