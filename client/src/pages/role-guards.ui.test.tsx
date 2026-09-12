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
      readings: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation }, updatePending: { useMutation: mocks.mutation }, deletePending: { useMutation: mocks.mutation }, approve: { useMutation: mocks.mutation } },
      tariffs: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation } },
      invoices: { list: { useQuery: () => mocks.query(mocks.invoices) }, createFromReading: { useMutation: mocks.mutation }, createShareLink: { useMutation: () => ({ mutate: mocks.createShareLink, isPending: false }) } },
      subscribers: { list: { useQuery: () => mocks.query(mocks.subscribers) }, quota: { useQuery: () => mocks.query({ limit: 100, currentCount: mocks.subscribers.length, remaining: 100 - mocks.subscribers.length, plan: "starter" }) }, phoneReview: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation }, bulkImport: { useMutation: mocks.mutation }, update: { useMutation: mocks.mutation }, applyPhoneNormalization: { useMutation: mocks.mutation } },
      generators: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation }, update: { useMutation: mocks.mutation } },
      payments: { list: { useQuery: () => mocks.query(mocks.payments) }, create: { useMutation: mocks.mutation } },
      companyAccounts: { list: { useQuery: () => mocks.query([]) } },
      expenses: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation } },
      dashboard: { summary: { useQuery: () => mocks.query({ financial: {} }) }, allBranchesSummary: { useQuery: () => mocks.query({ branchCount: 1, financial: {} }) }, financialOverview: { useQuery: () => mocks.query({ outstanding: { total: 0, overdue: 0, partialInvoices: 0, accountCount: 0 }, topDebtors: [] }) } },
      audit: { list: { useQuery: () => mocks.query([]) } },
      collectorSessions: { list: { useQuery: () => mocks.query([]) }, current: { useQuery: () => ({ data: undefined, isLoading: false, isFetching: false }) }, open: { useMutation: mocks.mutation }, close: { useMutation: mocks.mutation } },
      messaging: { listConfigurations: { useQuery: () => mocks.query([]) }, listScheduleRuns: { useQuery: () => mocks.query([]) }, smsQuota: { useQuery: () => mocks.query({ total: 0, used: 0, remaining: 0 }) }, smsDailyUsage: { useQuery: () => mocks.query({ points: [], total: 0, used: 0, remaining: 0 }) }, deliveryPolicy: { useQuery: () => mocks.query({ configured: true, isEnabled: true, whatsappEnabled: true, smsEnabled: true, message: "" }) }, listInvoiceTemplates: { useQuery: () => mocks.query([]) }, listPaymentReceiptTemplates: { useQuery: () => mocks.query([]) }, saveConfiguration: { useMutation: mocks.mutation }, testConnection: { useMutation: mocks.mutation }, saveInvoiceTemplate: { useMutation: mocks.mutation }, savePaymentReceiptTemplate: { useMutation: mocks.mutation }, configureInvoiceAutoSend: { useMutation: mocks.mutation }, requestSmsPackage: { useMutation: mocks.mutation } },
      subscriberPortal: { settings: { useQuery: () => mocks.query(mocks.portalSettings) }, saveSettings: { useMutation: mocks.mutation } },
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
    expect(screen... (truncated)