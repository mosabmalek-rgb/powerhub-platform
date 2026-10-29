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
import PaymentDocumentationPage from "./PaymentDocumentationPage";
import PublicInvoice from "./PublicInvoice";

const mocks = vi.hoisted(() => {
  const queryCache = new Map<string, { data: unknown; isLoading: boolean; isFetching: boolean }>();
  const queryCalls: Array<{ key: string; input?: unknown; enabled?: boolean }> = [];
  return {
  queryCalls,
  recordQuery: (key: string, input?: unknown, options?: { enabled?: boolean }) => {
    queryCalls.push({ key, input, enabled: options?.enabled });
  },
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
  paymentDocumentationAccessError: false,
  publicPaymentContext: {
    siteId: 1,
    paymentDocumentationAvailable: true,
    invoice: { id: 551, invoiceNo: "INV-TEST-0551", billingPeriod: "2026-10", previousReading: 10, currentReading: 10.5, consumptionKwh: 0.5, pricePerKwh: 30, fixedFee: 0, taxAmount: 0, discountAmount: 0.4, totalAmount: 30, paidAmount: 0, balanceDue: 30, status: "issued" },
    subscriber: { subscriberId: 21, fullName: "مشترك اختبار التوثيق", subscriberNo: "TEST-021" },
    accounts: [{ id: 90, name: "حساب الاستلام", accountType: "jawwal_pay", phoneNumber: "0590000000" }],
    lines: [
      { id: 1, lineType: "energy", description: "استهلاك الكهرباء", amount: 15, displayOrder: 1 },
      { id: 2, lineType: "other", description: "تسوية الحد الأدنى للاستهلاك", amount: 15, displayOrder: 2 },
      { id: 3, lineType: "discount", description: "خصم تلقائي لتسوية كسر الفاتورة", amount: 0.4, displayOrder: 3 },
      { id: 4, lineType: "other", description: "كسر مُرحّل إلى الفاتورة التالية", amount: -0.8, displayOrder: 4 }
    ]
  },
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
vi.mock("wouter", () => ({ useLocation: () => [mocks.location, vi.fn()], useRoute: (pattern: string) => pattern === "/payment-documentation/public/:token" && mocks.location.startsWith("/payment-documentation/public/") ? [true, { token: mocks.location.split("/").at(-1) }] : pattern === "/invoice/:token" && mocks.location.startsWith("/invoice/") ? [true, { token: mocks.location.split("/").at(-1) }] : [false, undefined] }));
vi.mock("@/lib/offline-connectivity", () => ({ usePowerHubConnectivity: () => ({ isOnline: true, reconnectGeneration: 0 }), probePowerHubConnectivity: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/offline-reading-queue", () => ({ enqueueReading: vi.fn(), listQueuedReadings: vi.fn().mockResolvedValue([]), removeQueuedReading: vi.fn(), updateQueuedReading: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ powerhub: { sites: { list: { invalidate: vi.fn() }, invoiceDuePolicy: { get: { invalidate: vi.fn() } } }, readingCycle: { get: { invalidate: vi.fn() } }, invoices: { list: { invalidate: vi.fn() }, page: { invalidate: vi.fn() } }, paymentDocumentation: { list: { invalidate: vi.fn() } }, siteBillingPolicy: { get: { invalidate: vi.fn() } }, dashboard: { summary: { invalidate: vi.fn() }, financialOverview: { invalidate: vi.fn() } }, audit: { list: { invalidate: vi.fn() } }, subscribers: { list: { invalidate: vi.fn() }, directoryPage: { invalidate: vi.fn(), prefetch: vi.fn().mockResolvedValue(undefined) }, quota: { invalidate: vi.fn() }, phoneReview: { invalidate: vi.fn() } }, generators: { list: { invalidate: vi.fn() } }, meters: { list: { invalidate: vi.fn() } }, readings: { list: { invalidate: vi.fn() }, page: { invalidate: vi.fn() } }, payments: { list: { invalidate: vi.fn() }, page: { invalidate: vi.fn() } }, expenses: { list: { invalidate: vi.fn() }, page: { invalidate: vi.fn() } }, messaging: { listConfigurations: { invalidate: vi.fn() }, smsDailyUsage: { invalidate: vi.fn() }, deliveryPolicy: { invalidate: vi.fn() }, listInvoiceTemplates: { invalidate: vi.fn() }, listPaymentReceiptTemplates: { invalidate: vi.fn() } }, notifications: { list: { invalidate: vi.fn() }, countDueInvoiceNotifications: { invalidate: vi.fn() }, listFailedSms: { invalidate: vi.fn() }, listBulkInvoiceSends: { invalidate: vi.fn() }, bulkInvoiceSendDetails: { invalidate: vi.fn() } }, collectorSessions: { list: { invalidate: vi.fn() }, current: { invalidate: vi.fn() } }, staff: { list: { invalidate: vi.fn() }, archived: { invalidate: vi.fn() }, allowedSubaccountRoles: { invalidate: vi.fn() }, activity: { invalidate: vi.fn() }, customRoles: { invalidate: vi.fn() } }, subscriberPortal: { settings: { invalidate: vi.fn() }, list: { invalidate: vi.fn() }, theme: { invalidate: vi.fn() } } } }),
    powerhub: {
      hr: {
        replayOfflineOperation: { useMutation: mocks.mutation },
        issueEmployeeAdvance: { useMutation: mocks.mutation },
        repayEmployeeAdvance: { useMutation: mocks.mutation },
      },
      offlineNumbering: { reserve: { useMutation: mocks.mutation } },
      sites: { list: { useQuery: () => mocks.query([mocks.site]) }, invoiceDuePolicy: { get: { useQuery: () => mocks.query({ invoiceDueHours: 336, invoiceDueDays: 14 }) }, save: { useMutation: mocks.mutation } }, branchPolicy: { useQuery: () => mocks.query({ isEnabled: false }) }, anomalyAlert: { useQuery: () => mocks.query({ anomalyAlertPercent: 50 }) }, create: { useMutation: mocks.mutation }, updateAnomalyAlert: { useMutation: mocks.mutation } },
      siteBillingPolicy: { get: { useQuery: () => mocks.query({ automaticFractionDiscountEnabled: false, fractionCarryEnabled: false }) }, save: { useMutation: mocks.mutation } },
      reportBranding: { get: { useQuery: () => mocks.query({ companyName: "PowerHub", logoUrl: null }) }, update: { useMutation: mocks.mutation } },
      readingCycle: { get: { useQuery: () => mocks.query({ cycleType: "MONTHLY", weeklyStartDay: 7, monthlyStartDay: 1 }) }, currentBounds: { useQuery: () => mocks.query({ cycleKey: "2026-10", cycleLabel: "أكتوبر 2026", billingPeriod: "2026-10", startAt: "2026-10-01T00:00:00.000Z", endAt: "2026-10-31T20:59:59.999Z" }) }, boundsAt: { useQuery: () => mocks.query({ cycleKey: "2026-09", cycleLabel: "سبتمبر 2026", billingPeriod: "2026-09", startAt: "2026-09-01T00:00:00.000Z", endAt: "2026-09-30T20:59:59.999Z" }) }, save: { useMutation: mocks.mutation } },
      staff: { myAccess: { useQuery: () => mocks.query({ role: mocks.activeRole }) }, directory: { useQuery: () => mocks.query([]) }, list: { useQuery: () => mocks.query([]) }, archived: { useQuery: () => mocks.query([]) }, allowedSubaccountRoles: { useQuery: () => mocks.query({ roles: ["manager", "accountant", "collector", "technician", "viewer"] }) }, assign: { useMutation: mocks.mutation }, archive: { useMutation: mocks.mutation }, restore: { useMutation: mocks.mutation }, setActive: { useMutation: mocks.mutation }, suspend: { useMutation: mocks.mutation }, clearSuspension: { useMutation: mocks.mutation }, create: { useMutation: mocks.mutation }, activity: { useQuery: () => mocks.query([]) }, resetPassword: { useMutation: mocks.mutation }, customRoles: { useQuery: () => mocks.query([]) }, permissionChanges: { useQuery: () => mocks.query([]) }, updatePermissions: { useMutation: mocks.mutation }, saveCustomRole: { useMutation: mocks.mutation }, deleteCustomRole: { useMutation: mocks.mutation } },
      meters: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation } },
      readings: { list: { useQuery: () => mocks.query([]) }, page: { useQuery: (input?: unknown, options?: { enabled?: boolean }) => { mocks.recordQuery("readings.page", input, options); return mocks.query({ items: [], hasNext: false, nextCursor: null }); } }, create: { useMutation: () => ({ mutate: mocks.createReadingMutate, mutateAsync: mocks.createReadingMutateAsync, isPending: false }) }, getImage: { useMutation: mocks.mutation }, updatePending: { useMutation: mocks.mutation }, deletePending: { useMutation: mocks.mutation }, approve: { useMutation: mocks.mutation } }, mobileSync: { approveAndIssue: { useMutation: mocks.mutation } },
      tariffs: { list: { useQuery: () => mocks.query([]) }, history: { useQuery: () => mocks.query({ items: [], total: 0, hasNext: false }) }, create: { useMutation: mocks.mutation }, update: { useMutation: mocks.mutation } },
      invoices: { list: { useQuery: () => mocks.query(mocks.invoices) }, page: { useQuery: (input?: unknown, options?: { enabled?: boolean }) => { mocks.recordQuery("invoices.page", input, options); return mocks.query({ items: mocks.invoices, hasNext: false, nextCursor: null }); } }, publicByToken: { useQuery: () => mocks.query({ siteId: 1, paymentDocumentationAvailable: true, invoice: mocks.publicPaymentContext.invoice, subscriber: mocks.publicPaymentContext.subscriber, lines: mocks.publicPaymentContext.lines }) }, createFromReading: { useMutation: mocks.mutation }, createShareLink: { useMutation: () => ({ mutate: mocks.createShareLink, isPending: false }) } },
      subscribers: {
        list: { useQuery: (input?: unknown, options?: { enabled?: boolean }) => { mocks.recordQuery("subscribers.list", input, options); return mocks.query(mocks.subscribers); } },
        directoryPage: { useQuery: (input: { page: number; pageSize: number; search?: string; subscriptionType?: string }, options?: { enabled?: boolean }) => {
          mocks.recordQuery("subscribers.directoryPage", input, options);
          const term = String(input.search ?? "").trim().toLocaleLowerCase("ar");
          const filtered = mocks.subscribers.filter((row) =>
            (!input.subscriptionType || row.subscriptionType === input.subscriptionType) &&
            (!term || [row.fullName, row.subscriberNo, row.phone, row.whatsappNumber, row.address].some((value) => String(value ?? "").toLocaleLowerCase("ar").includes(term))),
          );
          return mocks.query({ items: filtered.slice((input.page - 1) * input.pageSize, input.page * input.pageSize), totalCount: filtered.length, page: input.page, pageSize: input.pageSize, totalPages: Math.max(1, Math.ceil(filtered.length / input.pageSize)) });
        } },
        quota: { useQuery: (input?: unknown, options?: { enabled?: boolean }) => { mocks.recordQuery("subscribers.quota", input, options); return mocks.query({ limit: 100, currentCount: mocks.subscribers.length, remaining: 100 - mocks.subscribers.length, plan: "basic" }); } },
        phoneReview: { useQuery: () => mocks.query([]) },
        create: { useMutation: () => ({ mutate: mocks.createSubscriberMutate, isPending: false }) },
        bulkImport: { useMutation: mocks.mutation }, update: { useMutation: mocks.mutation }, applyPhoneNormalization: { useMutation: mocks.mutation }
      },
      generators: { list: { useQuery: (input?: unknown, options?: { enabled?: boolean }) => { mocks.recordQuery("generators.list", input, options); return mocks.query([]); } }, create: { useMutation: () => ({ mutate: mocks.createGeneratorMutate, isPending: false }) }, update: { useMutation: mocks.mutation } },
      payments: { list: { useQuery: () => mocks.query(mocks.payments) }, page: { useQuery: (input?: unknown, options?: { enabled?: boolean }) => { mocks.recordQuery("payments.page", input, options); return mocks.query({ items: mocks.payments, hasNext: false, nextCursor: null }); } }, getReceiptImage: { useMutation: () => ({ mutateAsync: vi.fn().mockResolvedValue({ url: "https://example.invalid/receipt" }), isPending: false }) }, create: { useMutation: mocks.mutation } },
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
      expenses: {
        filterAccounts: { useQuery: (input?: unknown, options?: { enabled?: boolean }) => {
          mocks.recordQuery("expenses.filterAccounts", input, options);
          return { ...mocks.query([{ id: 90, name: "كاش", accountType: "cash" }]), refetch: vi.fn() };
        } },
        list: { useQuery: () => mocks.query([]) },
        page: { useQuery: (input?: unknown, options?: { enabled?: boolean }) => { mocks.recordQuery("expenses.page", input, options); return { ...mocks.query({ items: [], hasNext: false, nextCursor: null }), refetch: vi.fn() }; } },
        create: { useMutation: mocks.mutation }
      },
      dashboard: { summary: { useQuery: (input?: unknown, options?: { enabled?: boolean }) => { mocks.recordQuery("dashboard.summary", input, options); return mocks.query({ financial: {} }); } }, allBranchesSummary: { useQuery: () => mocks.query({ branchCount: 1, financial: {} }) }, financialOverview: { useQuery: (input?: unknown, options?: { enabled?: boolean }) => { mocks.recordQuery("dashboard.financialOverview", input, options); return mocks.query({ outstanding: { total: 0, overdue: 0, partialInvoices: 0, accountCount: 0 }, topDebtors: [] }); } }, periodMetrics: { useQuery: (input?: { startDate?: string; endDate?: string; scope?: "branch" | "all" }) => mocks.query({ range: { startDate: input?.startDate ?? "2026-10-01", endDate: input?.endDate ?? "2026-10-31" }, scope: input?.scope ?? "branch", summary: { invoiced: 0, collected: 0, collectionRate: 0, outstanding: 0, overdue: 0, overdueInvoiceCount: 0, overdueSubscriberCount: 0 }, outstandingInvoices: [] }) } },
      paymentDocumentation: { publicStatus: { useQuery: () => ({ ...mocks.query({ hasPendingSubmission: false }), refetch: vi.fn() }) }, access: { useQuery: () => ({ ...mocks.query({ allowed: false, policy: "addon", packageCode: "growth", entitlementEnabled: false, adminStatus: "enabled", disabledByAdmin: false }), isError: mocks.paymentDocumentationAccessError, refetch: vi.fn(), error: mocks.paymentDocumentationAccessError ? new Error("status unavailable") : undefined }) }, publicContext: { useQuery: () => ({ ...mocks.query(mocks.publicPaymentContext), isLoading: false, isError: false, error: undefined }) }, publicSubmit: { useMutation: () => ({ ...mocks.mutation(), data: undefined }) }, searchSubscriber: { useQuery: () => mocks.query([]) }, availableAccounts: { useQuery: () => mocks.query(mocks.publicPaymentContext.accounts) }, ownerFeature: { useMutation: mocks.mutation }, submit: { useMutation: mocks.mutation }, approve: { useMutation: mocks.mutation } },
      audit: { list: { useQuery: (input?: unknown, options?: { enabled?: boolean }) => { mocks.recordQuery("audit.list", input, options); return mocks.query([]); } } },
      collectorSessions: { list: { useQuery: () => mocks.query([]) }, current: { useQuery: () => ({ data: undefined, isLoading: false, isFetching: false }) }, open: { useMutation: mocks.mutation }, close: { useMutation: mocks.mutation } },
      messaging: { listConfigurations: { useQuery: () => mocks.query([]) }, listScheduleRuns: { useQuery: () => mocks.query([]) }, smsQuota: { useQuery: () => mocks.query({ total: 0, used: 0, remaining: 0, providerMonthlyLimit: 0, providerMonthlyUsed: 0 }) }, smsCreditPackages: { useQuery: () => mocks.query([]) }, currentSmsPackageRequest: { useQuery: () => mocks.query(null) }, smsDailyUsage: { useQuery: () => mocks.query({ points: [], total: 0, used: 0, remaining: 0 }) }, deliveryPolicy: { useQuery: () => mocks.query({ configured: true, isEnabled: true, whatsappEnabled: true, smsEnabled: true, message: "" }) }, listInvoiceTemplates: { useQuery: () => mocks.query([]) }, listPaymentReceiptTemplates: { useQuery: () => mocks.query([]) }, saveConfiguration: { useMutation: mocks.mutation }, testConnection: { useMutation: mocks.mutation }, saveInvoiceTemplate: { useMutation: mocks.mutation }, savePaymentReceiptTemplate: { useMutation: mocks.mutation }, configureInvoiceAutoSend: { useMutation: mocks.mutation }, requestSmsPackage: { useMutation: mocks.mutation } },
      subscriberPortal: { settings: { useQuery: () => mocks.query(mocks.portalSettings) }, saveSettings: { useMutation: mocks.mutation }, uploadLogo: { useMutation: mocks.mutation }, removeLogo: { useMutation: mocks.mutation } },
      notifications: { list: { useQuery: (input?: unknown, options?: { enabled?: boolean }) => { mocks.recordQuery("notifications.list", input, options); return mocks.query(mocks.notifications); } }, countDueInvoiceNotifications: { useQuery: () => mocks.query({ count: 0 }) }, listFailedSms: { useQuery: () => mocks.query([]) }, listBulkInvoiceSends: { useQuery: () => mocks.query(mocks.bulkInvoiceSends) }, bulkInvoiceSendDetails: { useQuery: () => mocks.query(mocks.bulkInvoiceSendDetails) }, retry: { useMutation: mocks.mutation }, retryFailedSmsBatch: { useMutation: mocks.mutation }, resolveSmsNeedsReview: { useMutation: mocks.mutation }, retryFailedInvoiceNotification: { useMutation: () => ({ mutate: mocks.retryFailedInvoiceNotification, isPending: false }) }, retryFailedInvoiceNotifications: { useMutation: () => ({ mutate: mocks.retryFailedInvoiceNotifications, isPending: false }) }, retryPaymentReceipt: { useMutation: mocks.mutation }, sendPaymentReceiptSms: { useMutation: () => ({ mutate: mocks.sendPaymentReceiptSms, isPending: false }) }, sendPaymentReminderSms: { useMutation: () => ({ mutate: mocks.sendPaymentReminderSms, isPending: false, variables: undefined }) }, sendBulkInvoiceSms: { useMutation: () => ({ mutate: mocks.sendBulkInvoiceSms, isPending: false }) }, sendAllEligibleInvoiceSms: { useMutation: () => ({ mutate: mocks.sendBulkInvoiceSms, isPending: false }) }, sendDeferredInvoices: { useMutation: () => ({ mutate: mocks.sendDeferredInvoices, isPending: false }) }, sendPendingSms: { useMutation: () => ({ mutate: mocks.sendPendingSms, isPending: false }) } },
    },
  },
}));

afterEach(() => { cleanup(); mocks.queryCalls.length = 0; vi.restoreAllMocks(); mocks.createSubscriberMutate.mockClear(); mocks.createGeneratorMutate.mockClear(); mocks.createReadingMutate.mockClear(); mocks.createReadingMutateAsync.mockClear(); mocks.activeRole = "viewer"; mocks.location = "/readings"; mocks.paymentDocumentationAccessError = false; mocks.subscribers = []; mocks.invoices = []; mocks.notifications = []; mocks.bulkInvoiceSends = []; mocks.bulkInvoiceSendDetails = { items: [] }; mocks.payments = []; mocks.publicPaymentContext = { siteId: 1, paymentDocumentationAvailable: true, invoice: { id: 551, invoiceNo: "INV-TEST-0551", billingPeriod: "2026-10", previousReading: 10, currentReading: 10.5, consumptionKwh: 0.5, pricePerKwh: 30, fixedFee: 0, taxAmount: 0, discountAmount: 0.4, totalAmount: 30, paidAmount: 0, balanceDue: 30, status: "issued" }, subscriber: { subscriberId: 21, fullName: "مشترك اختبار التوثيق", subscriberNo: "TEST-021" }, accounts: [{ id: 90, name: "حساب الاستلام", accountType: "jawwal_pay", phoneNumber: "0590000000" }], lines: [{ id: 1, lineType: "energy", description: "استهلاك الكهرباء", amount: 15, displayOrder: 1 }, { id: 2, lineType: "other", description: "تسوية الحد الأدنى للاستهلاك", amount: 15, displayOrder: 2 }, { id: 3, lineType: "discount", description: "خصم تلقائي لتسوية كسر الفاتورة", amount: 0.4, displayOrder: 3 }, { id: 4, lineType: "other", description: "كسر مُرحّل إلى الفاتورة التالية", amount: -0.8, displayOrder: 4 }] }; mocks.createShareLink.mockReset(); mocks.sendDeferredInvoices.mockReset(); mocks.sendPendingSms.mockReset(); mocks.sendBulkInvoiceSms.mockReset(); mocks.retryFailedInvoiceNotification.mockReset(); mocks.retryFailedInvoiceNotifications.mockReset(); mocks.sendPaymentReceiptSms.mockReset(); });

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

  it("shows subscriber names instead of a select-all column and preserves individual bulk-send selection", () => {
    mocks.activeRole = "owner";
    mocks.subscribers = [
      { id: 101, fullName: "أحمد حسن", subscriberNo: "SUB-101", phone: "0599000101" },
      { id: 102, fullName: "سارة علي", subscriberNo: "SUB-102", phone: "0599000102" },
    ];
    mocks.invoices = [
      { id: 81, subscriberId: 101, invoiceNo: "PH-TEST-0081", billingPeriod: "2026-08", consumptionKwh: "12", totalAmount: "60", paidAmount: "0", balanceDue: "60", status: "issued" } as any,
      { id: 82, subscriberId: 102, invoiceNo: "PH-TEST-0082", billingPeriod: "2026-08", consumptionKwh: "18", totalAmount: "90", paidAmount: "0", balanceDue: "90", status: "issued" } as any,
    ];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<BillingPage />);
    expect(screen.getByRole("columnheader", { name: "اسم المشترك" })).toBeInTheDocument();
    expect(screen.getByText("أحمد حسن")).toBeInTheDocument();
    expect(screen.getByText("سارة علي")).toBeInTheDocument();
    expect(screen.queryByLabelText("تحديد كل الفواتير غير المرسلة في الصفحة")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("تحديد الفاتورة PH-TEST-0081"));
    fireEvent.click(screen.getByLabelText("تحديد الفاتورة PH-TEST-0082"));
    expect(screen.getByLabelText("تحديد الفاتورة PH-TEST-0081")).toBeChecked();
    expect(screen.getByLabelText("تحديد الفاتورة PH-TEST-0082")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /إرسال المحددة/ }));
    expect(mocks.sendBulkInvoiceSms).toHaveBeenCalledWith({ siteId: 1, invoiceIds: [81, 82] });
  });

  it("does not let failed or scheduled SMS invoices enter the ordinary bulk-send selection", () => {
    mocks.activeRole = "owner";
    mocks.subscribers = [
      { id: 101, fullName: "أحمد حسن", subscriberNo: "SUB-101", phone: "0599000101" },
      { id: 102, fullName: "سارة علي", subscriberNo: "SUB-102", phone: "0599000102" },
    ];
    mocks.invoices = [
      { id: 81, subscriberId: 101, invoiceNo: "PH-TEST-0081", billingPeriod: "2026-08", consumptionKwh: "12", totalAmount: "60", paidAmount: "0", balanceDue: "60", status: "issued" } as any,
      { id: 82, subscriberId: 102, invoiceNo: "PH-TEST-0082", billingPeriod: "2026-08", consumptionKwh: "18", totalAmount: "90", paidAmount: "0", balanceDue: "90", status: "issued" } as any,
    ];
    mocks.notifications = [
      { notification: { invoiceId: 81, status: "failed", scheduledAt: null } },
      { notification: { invoiceId: 82, status: "pending", scheduledAt: new Date("2099-01-01T00:00:00.000Z") } },
    ];
    render(<BillingPage />);
    expect(screen.getByLabelText("تحديد الفاتورة PH-TEST-0081")).toBeDisabled();
    expect(screen.getByLabelText("تحديد الفاتورة PH-TEST-0082")).toBeDisabled();
    expect(screen.queryByLabelText("تحديد كل الفواتير غير المرسلة في الصفحة")).not.toBeInTheDocument();
    expect(screen.getByText("أحمد حسن")).toBeInTheDocument();
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

  it("shows no more than 20 subscribers per page and can navigate to the 21st subscriber", () => {
    mocks.activeRole = "viewer";
    mocks.subscribers = Array.from({ length: 23 }, (_, index) => ({
      id: index + 1,
      fullName: `مشترك اختبار ${String(index + 1).padStart(2, "0")}`,
      subscriberNo: `SUB-${String(index + 1).padStart(6, "0")}`,
      phone: `+970599000${String(index + 1).padStart(3, "0")}`,
      subscriptionType: index === 20 ? "institution" : index === 21 ? "mosque" : "residential",
      serviceStatus: "active",
    }));
    render(<NetworkDirectoryPage kind="subscribers" />);
    expect(screen.getByText("مشترك اختبار 01")).toBeInTheDocument();
    expect(screen.getByText("مشترك اختبار 20")).toBeInTheDocument();
    expect(screen.queryByText("مشترك اختبار 21")).not.toBeInTheDocument();
    expect(screen.getByText(/عرض 20 مشتركاً كحد أقصى/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "التالي" }));
    expect(screen.getByText("مشترك اختبار 21")).toBeInTheDocument();
    expect(screen.getByText("مشترك اختبار 23")).toBeInTheDocument();
    expect(screen.queryByText("مشترك اختبار 01")).not.toBeInTheDocument();
  });

  it("filters the subscriber directory by institution and mosque type", () => {
    mocks.subscribers = [
      { id: 201, fullName: "مشترك سكني", subscriberNo: "SUB-000201", phone: "+970599000201", subscriptionType: "residential", serviceStatus: "active" },
      { id: 202, fullName: "مؤسسة", subscriberNo: "SUB-000202", phone: "+970599000202", subscriptionType: "institution", serviceStatus: "active" },
      { id: 203, fullName: "مسجد", subscriberNo: "SUB-000203", phone: "+970599000203", subscriptionType: "mosque", serviceStatus: "active" },
    ];
    render(<NetworkDirectoryPage kind="subscribers" />);
    fireEvent.change(screen.getByLabelText("فلتر نوع المشترك"), { target: { value: "institution" } });
    expect(screen.getByText("مؤسسة")).toBeInTheDocument();
    expect(screen.queryByText("مشترك سكني")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("فلتر نوع المشترك"), { target: { value: "mosque" } });
    expect(screen.getByText("مسجد")).toBeInTheDocument();
    expect(screen.queryByText("مؤسسة")).not.toBeInTheDocument();
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

  it("hides every zero-value invoice row while keeping real minimum-consumption adjustments visible", () => {
    mocks.location = "/payment-documentation/public/test-share-token-00000001";
    mocks.publicPaymentContext.lines = [
      { id: 11, lineType: "energy", description: "استهلاك الكهرباء", amount: 15, displayOrder: 1 },
      { id: 12, lineType: "other", description: "تسوية الحد الأدنى للاستهلاك", amount: 15, displayOrder: 2 },
      { id: 13, lineType: "discount", description: "خصم تلقائي لتسوية كسر الفاتورة", amount: 0, displayOrder: 3 },
      { id: 14, lineType: "other", description: "كسر مُرحّل إلى الفاتورة التالية", amount: 0.0049, displayOrder: 4 },
      { id: 15, lineType: "fixed_fee", description: "رسم ثابت", amount: 0, displayOrder: 5 },
      { id: 16, lineType: "tax", description: "الضريبة", amount: 0, displayOrder: 6 },
      { id: 17, lineType: "other", description: "بند إضافي بلا قيمة", amount: 0, displayOrder: 7 },
    ];
    render(<PaymentDocumentationPage />);
    expect(screen.getByText("تسوية الحد الأدنى للاستهلاك")).toBeInTheDocument();
    expect(screen.queryByText("خصم تلقائي لتسوية كسر الفاتورة")).not.toBeInTheDocument();
    expect(screen.queryByText("كسر مُرحّل إلى الفاتورة التالية")).not.toBeInTheDocument();
    expect(screen.queryByText("رسم ثابت")).not.toBeInTheDocument();
    expect(screen.queryByText("الضريبة")).not.toBeInTheDocument();
    expect(screen.queryByText("بند إضافي بلا قيمة")).not.toBeInTheDocument();
  });

  it("shows automatic fractional discounts, carried fractions, and minimum-consumption adjustments on payment documentation", () => {
    mocks.location = "/payment-documentation/public/test-share-token-00000001";
    render(<PaymentDocumentationPage />);
    expect(screen.getByText("تفاصيل الفاتورة وتسوياتها")).toBeInTheDocument();
    expect(screen.getByText("تسوية الحد الأدنى للاستهلاك")).toBeInTheDocument();
    expect(screen.getByText("خصم تلقائي لتسوية كسر الفاتورة")).toBeInTheDocument();
    expect(screen.getByText("تسوية الكسر المرحّل")).toBeInTheDocument();
    expect(screen.getByText("كسر مُرحّل إلى الفاتورة التالية")).toBeInTheDocument();
    expect(screen.getByText(/0\.80\s*شيكل/)).toBeInTheDocument();
    const receiver = screen.getByText("الحساب المستقبِل");
    const method = screen.getByText("طريقة/نوع حساب التحويل");
    expect(receiver.compareDocumentPosition(method) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the carried-fraction effect on shared invoices and hides every zero-value line", () => {
    mocks.location = "/invoice/test-share-token-00000001";
    mocks.publicPaymentContext.lines = [
      { id: 31, lineType: "energy", description: "استهلاك الكهرباء", amount: 126.9, displayOrder: 1 },
      { id: 32, lineType: "fixed_fee", description: "رسم ثابت", amount: 0, displayOrder: 3 },
      { id: 33, lineType: "tax", description: "الضريبة", amount: 0, displayOrder: 4 },
      { id: 34, lineType: "other", description: "بند بلا قيمة", amount: 0, displayOrder: 5 },
      { id: 35, lineType: "other", description: "كسر مُرحّل إلى الفاتورة التالية", amount: -0.9, displayOrder: 8 },
    ];
    render(<PublicInvoice />);
    expect(screen.getByText("بنود الفاتورة")).toBeInTheDocument();
    expect(screen.getByText("تسوية الكسر المرحّل")).toBeInTheDocument();
    expect(screen.getByText("كسر مُرحّل إلى الفاتورة التالية")).toBeInTheDocument();
    expect(screen.getByText(/0\.90\s*شيكل/)).toBeInTheDocument();
    expect(screen.queryByText("رسم ثابت")).not.toBeInTheDocument();
    expect(screen.queryByText("الضريبة")).not.toBeInTheDocument();
    expect(screen.queryByText("بند بلا قيمة")).not.toBeInTheDocument();
  });

  it("does not misrepresent or allow toggling payment documentation when its state cannot be checked", () => {
    mocks.activeRole = "owner";
    mocks.location = "/settings";
    mocks.paymentDocumentationAccessError = true;
    render(<SettingsPage />);
    expect(screen.getByText("تعذر التحقق من الحالة")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تفعيل التوثيق" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "إلغاء تفعيل التوثيق" })).toBeDisabled();
  });

  it("shows invoice due interval controls only in Settings and defaults legacy 14 days to 336 hours", () => {
    mocks.activeRole = "owner";
    mocks.location = "/settings";
    render(<SettingsPage />);
    expect(screen.getByText("مدة استحقاق الفاتورة")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "مدة استحقاق الفاتورة" })).toHaveValue(14);
    expect(screen.getByRole("combobox", { name: "وحدة استحقاق الفاتورة" })).toHaveValue("days");
    expect(screen.getByText(/تُحفظ المدة بالساعات داخليًا/)).toBeInTheDocument();
  });

  it("shows team administration to the owner", () => {
    mocks.activeRole = "owner";
    mocks.location = "/staff";
    render(<SettingsPage />);
    expect(screen.getByRole("button", { name: /حفظ الدور/ })).toBeInTheDocument();
  });

  it("reflects the effective payment-documentation state from the feature access query", () => {
    mocks.activeRole = "owner";
    mocks.location = "/settings";
    render(<SettingsPage />);
    expect(screen.getByText("غير فعالة فعلياً")).toBeInTheDocument();
    expect(screen.getByText("إتاحة الحساب: متوقفة")).toBeInTheDocument();
    expect(screen.getByText("إدارة المنصة: مفعّلة")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تفعيل التوثيق" })).toBeEnabled();
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
    fireEvent.click(screen.getByRole("button", { name: /فتح البطاقة/ }));
    expect(screen.getByText(/دورك يتيح مراجعة التحصيلات فقط/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /تسجيل الدفعة/ })).not.toBeInTheDocument();
  });

  it("shows payment entry to the collector after opening the collapsed collection card", () => {
    mocks.activeRole = "collector";
    render(<OperationsPage section="collections" />);
    fireEvent.click(screen.getByRole("button", { name: /فتح البطاقة/ }));
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
    expect(screen.queryByRole("button", { name: /^تصحيح$/ })).not.toBeInTheDocument();
  });

  it("keeps the receiving company account inside the payment form without duplicate destination fields", () => {
    mocks.activeRole = "owner";
    render(<OperationsPage section="collections" />);
    fireEvent.click(screen.getByRole("button", { name: /فتح البطاقة/ }));
    const form = screen.getByRole("button", { name: "تسجيل الدفعة" }).closest("form");
    expect(form).not.toBeNull();
    const destination = screen.getByRole("combobox", { name: "الحساب المستقبِل للتحصيل" });
    expect(form).toContainElement(destination);
    fireEvent.change(destination, { target: { value: "90" } });
    expect(screen.getByText(/سيُسجل التحصيل في حساب/)).toBeInTheDocument();
    expect(form?.querySelector('[name="transferToAccount"]')).toBeNull();
    expect(form?.querySelector('[name="transferToType"]')).toBeNull();
  });

  it("does not show collector session opening or closing controls to an owner", () => {
    mocks.activeRole = "owner";
    render(<OperationsPage section="collections" />);
    expect(screen.queryByRole("button", { name: "فتح جلسة تحصيل" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "إغلاق الجلسة" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /سجل جلسات التحصيل/ })).toBeInTheDocument();
  });

  it("shows the collector session opening flow to the collector", () => {
    mocks.activeRole = "collector";
    render(<OperationsPage section="collections" />);
    expect(screen.getByText(/افتح جلسة قبل تسجيل دفعاتك الميدانية/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "فتح جلسة تحصيل" })).toBeInTheDocument();
  });

  it("shows receipt print and SMS actions for a partial payment while declaring WhatsApp unavailable", () => {
    mocks.activeRole = "owner";
    mocks.invoices = [{ id: 50, invoiceNo: "INV-PARTIAL", billingPeriod: "2026-10", consumptionKwh: "5", totalAmount: "100", paidAmount: "40", balanceDue: "60", status: "partially_paid" } as any];
    mocks.payments = [{ payment: { id: 70, invoiceId: 50, paymentNo: "PAY-PARTIAL", amount: "40", paymentMethod: "cash", paidAt: new Date("2026-10-12") }, subscriber: { fullName: "مشترك اختبار", phone: "970599000000" }, invoiceNo: "INV-PARTIAL" }];
    render(<OperationsPage section="collections" />);
    expect(screen.getByRole("button", { name: "طباعة" })).toBeInTheDocument();
    expect(screen.getByText("إرسال إيصال WhatsApp غير متاح حاليًا")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "WhatsApp" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "SMS" }));
    expect(mocks.sendPaymentReceiptSms).toHaveBeenCalledWith({ siteId: 1, paymentId: 70, channel: "sms" });
    expect(mocks.sendPaymentReceiptSms).not.toHaveBeenCalledWith({ siteId: 1, paymentId: 70, channel: "whatsapp" });
  });

  it("lets an accountant create a public share link from an issued invoice in the invoice center", () => {
    mocks.activeRole = "accountant";
    mocks.invoices = [{ id: 44, invoiceNo: "PH-TEST-0044", billingPeriod: "2026-08", consumptionKwh: "50", totalAmount: "75", paidAmount: "0", balanceDue: "75", status: "issued", issueDate: new Date().toISOString(), cycleStartAt: null } as any];
    render(<BillingPage />);
    fireEvent.click(screen.getByRole("button", { name: /نسخ رابط الفاتورة/ }));
    expect(mocks.createShareLink).toHaveBeenCalledWith({ siteId: 1, invoiceId: 44 });
  });

  it("filters expense history by Gaza billing period and paying company account", () => {
    mocks.activeRole = "accountant";
    render(<OperationsPage section="expenses" />);
    const period = screen.getByLabelText("فلتر فترة المصروفات");
    const account = screen.getByLabelText("فلتر الحساب المصروف منه");
    expect(period).toHaveValue("cycle");
    expect(account).toHaveValue("");
    fireEvent.change(period, { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("بداية فترة المصروفات"), { target: { value: "2026-10-03" } });
    fireEvent.change(screen.getByLabelText("نهاية فترة المصروفات"), { target: { value: "2026-10-12" } });
    fireEvent.change(account, { target: { value: "90" } });
    const expenseQueries = mocks.queryCalls.filter((call) => call.key === "expenses.page" && call.enabled === true);
    expect(expenseQueries.at(-1)?.input).toMatchObject({
      siteId: 1,
      startDate: "2026-10-03",
      endDate: "2026-10-12",
      companyAccountId: 90,
    });
    expect(screen.getByRole("option", { name: "اليوم" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "هذه الدورة" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "حتى آخر الشهر" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "مخصص" })).toBeInTheDocument();
  });

  it("offers the same server-filtered expense history to read-only viewers", () => {
    mocks.activeRole = "viewer";
    render(<OperationsPage section="expenses" />);
    const period = screen.getByLabelText("فلتر فترة المصروفات");
    const account = screen.getByLabelText("فلتر الحساب المصروف منه");
    expect(period).toHaveValue("cycle");
    expect(screen.getByRole("option", { name: "كاش — cash" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "حفظ المصروف" })).not.toBeInTheDocument();
    fireEvent.change(period, { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("بداية فترة المصروفات"), { target: { value: "2026-10-03" } });
    fireEvent.change(screen.getByLabelText("نهاية فترة المصروفات"), { target: { value: "2026-10-12" } });
    fireEvent.change(account, { target: { value: "90" } });
    const expenseQueries = mocks.queryCalls.filter((call) => call.key === "expenses.page" && call.enabled === true);
    expect(expenseQueries.at(-1)?.input).toMatchObject({
      siteId: 1,
      startDate: "2026-10-03",
      endDate: "2026-10-12",
      companyAccountId: 90,
    });
    expect(mocks.queryCalls.some((call) => call.key === "expenses.filterAccounts" && call.enabled === true)).toBe(true);
  });

  it("loads only queries required by each operational section", () => {
    mocks.activeRole = "owner";
    const cases = [
      { section: "subscribers", expected: ["subscribers.list"] },
      { section: "generators", expected: ["generators.list"] },
      { section: "readings", expected: ["subscribers.list", "readings.page"] },
      { section: "invoices", expected: ["invoices.page"] },
      { section: "collections", expected: ["subscribers.list", "invoices.page", "payments.page"] },
      { section: "expenses", expected: ["generators.list", "expenses.page", "dashboard.summary"] },
      { section: "reports", expected: ["dashboard.summary"] },
      { section: "notifications", expected: ["notifications.list"] },
      { section: "audit", expected: ["audit.list"] },
    ] as const;
    for (const testCase of cases) {
      const view = render(<OperationsPage section={testCase.section} />);
      const enabled = mocks.queryCalls.filter((call) => call.enabled === true).map((call) => call.key).sort();
      expect(enabled, `enabled query set for ${testCase.section}`).toEqual([...testCase.expected].sort());
      view.unmount();
      mocks.queryCalls.length = 0;
    }
  });

  it("loads the financial overview only on the subscriber directory and generators only on the generator directory", () => {
    mocks.activeRole = "owner";
    const subscribersView = render(<NetworkDirectoryPage kind="subscribers" />);
    let enabled = mocks.queryCalls.filter((call) => call.enabled === true).map((call) => call.key).sort();
    expect(enabled).toEqual(["dashboard.financialOverview", "subscribers.directoryPage", "subscribers.quota"]);
    subscribersView.unmount();
    mocks.queryCalls.length = 0;
    const generatorsView = render(<NetworkDirectoryPage kind="generators" />);
    enabled = mocks.queryCalls.filter((call) => call.enabled === true).map((call) => call.key).sort();
    expect(enabled).toEqual(["generators.list"]);
    generatorsView.unmount();
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
