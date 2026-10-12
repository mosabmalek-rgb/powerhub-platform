// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceHome } from "./Home";
import PublicInvoice from "./PublicInvoice";
import ReportsPage from "./ReportsPage";

if (!globalThis.ResizeObserver) {
  class ResizeObserverMock { observe() {} unobserve() {} disconnect() {} }
  Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserverMock, writable: true });
}

const state = vi.hoisted(() => ({
  user: undefined as { role: "admin" | "user"; platformRole?: "platform_owner" | "platform_admin" | "finance_admin" | null; mustChangePassword?: boolean } | undefined,
  setLocation: vi.fn(),
}));

const report = {
  range: { startDate: "2026-08-01", endDate: "2026-08-21" },
  summary: { invoiced: 125, collected: 100, outstanding: 25, energyKwh: 80, expenseTotal: 10, operatingProfit: 90 },
  collectors: [{ name: "المحصل التجريبي", count: 2, amount: 100 }],
  topDebtors: [{ subscriber: "المشترك التجريبي", invoiceNo: "PH-TEST-01", balanceDue: 25 }],
};

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: true, loading: false, user: state.user }) }));
vi.mock("@/components/DashboardLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("wouter", () => ({ useRoute: () => [true, { token: "1234567890123456" }], useLocation: () => ["/workspace", state.setLocation] }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    powerhub: {
      sites: { list: { useQuery: () => ({ data: [{ id: 7, name: "محطة التقرير", code: "REPORT-01" }] }) }, branchPolicy: { useQuery: () => ({ data: { isEnabled: true, maxBranches: 3, currentCount: 1, remaining: 2 }, isLoading: false }) } },
      dashboard: { summary: { useQuery: () => ({ data: { energyKwh: 42, subscribers: 3, financial: { collected: 100, outstanding: 25 }, generators: { active: 1, maintenance: 0 } } }) }, allBranchesSummary: { useQuery: () => ({ data: { branchCount: 1, energyKwh: 42, subscribers: 3, financial: { collected: 100, outstanding: 25 }, generators: { active: 1, maintenance: 0 } } }) }, financialOverview: { useQuery: () => ({ data: { period: { today: "2026-08-21", month: "2026-08" }, today: { invoiced: 50, collected: 40, collectionRate: 80 }, month: { invoiced: 125, collected: 100, expenses: 10, netCash: 90, collectionRate: 80 }, outstanding: { total: 25, overdue: 15, partialInvoices: 1, accountCount: 1 }, branchSummaries: [{ id: 7, name: "محطة التقرير", activeSubscribers: 3, invoiced: 125, collected: 100, outstanding: 25, overdue: 15, partialInvoices: 1, collectionRate: 80 }], topDebtors: [{ subscriber: "المشترك التجريبي", subscriberNo: "PH-TEST", branchName: "محطة التقرير", outstanding: 25, ageDays: 4, partialInvoices: 1, isOverdue: true }] } }) } },
      performance: {
        readingKpis: { useQuery: () => ({ data: { consumption: 0, average: 0, approvedCount: 0, pendingCount: 0, latestReadingAt: null }, isLoading: false, isError: false }) },
        allBranchesReadingKpis: { useQuery: () => ({ data: { consumption: 0, average: 0, approvedCount: 0, pendingCount: 0, latestReadingAt: null }, isLoading: false, isError: false }) },
        collectorPerformance: { useQuery: () => ({ data: { openCount: 0, closedCount: 0, varianceCount: 0, netVariance: 0, collectors: [] }, isLoading: false, isError: false }) },
        allBranchesCollectorPerformance: { useQuery: () => ({ data: { openCount: 0, closedCount: 0, varianceCount: 0, netVariance: 0, collectors: [] }, isLoading: false, isError: false }) },
      },
      companyAccounts: { list: { useQuery: () => ({ data: [] }) } },
      subscribers: { quota: { useQuery: () => ({ data: { plan: "basic", limit: 100, currentCount: 3, remaining: 97 } }) } },
      staff: { myAccess: { useQuery: () => ({ data: { role: "owner" } }) }, allBranchAccess: { useQuery: () => ({ data: { isGlobal: true } }) } },
      messaging: { smsQuota: { useQuery: () => ({ data: { total: 100, used: 10, remaining: 90, senderName: "PowerHub", configured: true, isActive: true, lastError: null }, isLoading: false }) }, smsDailyUsage: { useQuery: () => ({ data: { points: [], total: 100, used: 10, remaining: 90 }, isLoading: false }) }, currentSmsPackageRequest: { useQuery: () => ({ data: null, isLoading: false }) }, requestSmsPackage: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } },
      subscription: { currentUpgradeRequest: { useQuery: () => ({ data: null }) }, requestUpgrade: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } },
      reports: { range: { useQuery: () => ({ data: report }) }, allBranchesRange: { useQuery: () => ({ data: { ...report, scope: { branchCount: 1 }, branchSummaries: [] } }) } },
      reportBranding: { get: { useQuery: () => ({ data: { companyName: "شركة التقرير", reportLogoKey: null, logoUrl: null } }) }, update: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } },
      invoices: { publicByToken: { useQuery: () => ({ data: {
        companyName: "مولدات السيف",
        companyLogoUrl: null,
        invoice: {
          invoiceNo: "PH-PUBLIC-0001", billingPeriod: "2026-08", status: "issued",
          previousReading: "100.5", currentReading: "142.5", consumptionKwh: "42", pricePerKwh: "1.5",
          fixedFee: 0, taxAmount: 0, balanceDue: "63",
        },
        subscriber: { fullName: "مستخدم الرابط العام" },
        lines: [
          { id: 1, description: "استهلاك الكهرباء", amount: "63" },
          { id: 2, description: "الرسم الثابت", amount: "0" },
          { id: 3, description: "الضريبة", amount: "0" },
        ],
      }, isLoading: false, isError: false }) } },
    },
  },
}));

describe("supplemental PowerHub page review", () => {
  afterEach(cleanup);

  it("renders the public invoice through its share route without authentication", () => {
    render(<PublicInvoice />);
    expect(screen.getByText("فاتورة قابلة للمشاركة")).toBeInTheDocument();
    expect(screen.getByText(/مستخدم الرابط العام/)).toBeInTheDocument();
    expect(screen.getByText("PH-PUBLIC-0001")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /نسخ رابط الفاتورة/ })).toBeInTheDocument();
  });

  it("centers the shared invoice title, shows company name and reading details, and hides zero fee/tax lines", () => {
    render(<PublicInvoice />);

    const title = screen.getByRole("heading", { name: "فاتورة كهرباء" });
    expect(title.parentElement).toHaveClass("text-center");
    expect(screen.getByText("مولدات السيف")).toBeInTheDocument();
    expect(screen.getByText("مستخدم الرابط العام")).toHaveClass("text-2xl");
    expect(screen.getByText("القراءة السابقة")).toBeInTheDocument();
    expect(screen.getByText("القراءة الحالية")).toBeInTheDocument();
    expect(screen.getByText("سعر الكيلوواط")).toBeInTheDocument();
    expect(screen.getByText(/١٠٠٫٥|100\.5/)).toBeInTheDocument();
    expect(screen.getByText(/١٤٢٫٥|142\.5/)).toBeInTheDocument();
    expect(screen.queryByText("الرسم الثابت")).not.toBeInTheDocument();
    expect(screen.queryByText("الضريبة")).not.toBeInTheDocument();

    const logo = screen.getByRole("img", { name: "PowerHub — منصة إدارة مولدات الكهرباء" });
    expect(logo.querySelector("img")).toHaveClass("h-[6.75rem]");
    expect(logo.querySelector("img")).toHaveClass("w-[21.6rem]");
  });

  it("selects the tenant site and displays the report's operational and financial data", async () => {
    render(<ReportsPage />);
    expect(screen.getByRole("option", { name: "محطة التقرير" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("المحصل التجريبي").length).toBeGreaterThan(0));
    expect(screen.getByText("أعلى الأرصدة المستحقة")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("تاريخ بداية التقرير"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("تاريخ نهاية التقرير"), { target: { value: "2026-07-31" } });
    expect(screen.getByLabelText("تاريخ بداية التقرير")).toHaveValue("2026-07-01");
    expect(screen.getByLabelText("تاريخ نهاية التقرير")).toHaveValue("2026-07-31");
    expect(screen.getByRole("button", { name: "CSV" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Excel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /PDF رسمي/ })).toBeEnabled();
    expect(screen.getByText("مقارنة الأداء المالي")).toBeInTheDocument();
    expect(screen.getByLabelText("رسم أعمدة المقارنة المالية")).toBeInTheDocument();
    expect(screen.getByLabelText("رسم نسبة التغير المالي")).toBeInTheDocument();
  });

  it("renders dashboard metrics for the selected tenant site", async () => {
    render(<WorkspaceHome />);
    expect(screen.getByRole("combobox", { name: "اختيار الفرع أو الملخص المجمع" })).toHaveValue("7");
    await waitFor(() => expect(screen.getByText("تحصيل الشهر")).toBeInTheDocument());
    expect(screen.getByText("أولوية المتأخرات")).toBeInTheDocument();
  });

  it("routes a platform admin away from the generator workspace to the admin center", async () => {
    state.user = { role: "admin", platformRole: "platform_admin" };
    render(<WorkspaceHome />);
    await waitFor(() => expect(screen.getByText("جارٍ فتح المساحة المصرح بها…")).toBeInTheDocument());
    state.user = undefined;
    state.setLocation.mockReset();
  });
});
