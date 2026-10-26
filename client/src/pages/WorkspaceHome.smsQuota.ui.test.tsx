// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceHome } from "./Home";

const state = vi.hoisted(() => ({
  authLoading: false,
  isAuthenticated: true,
  user: { id: 4, role: "user", mustChangePassword: false } as { id: number; role: string; mustChangePassword: boolean } | null,
  accessRole: "owner" as string,
  financialOverviewEnabled: true,
  periodMetricsEnabled: true,
  setLocation: vi.fn(),
  configured: true,
  isActive: true,
  remaining: 458,
  branchPolicy: { isEnabled: true, maxBranches: 3, currentCount: 1, remaining: 2 },
  subscriberQuota: { limit: 100, currentCount: 25, remaining: 75, plan: "basic" },
  smsUsed: 42,
  branchPolicyError: false,
  financialOverviewError: false,
  companyAccountsError: false,
  refetchFinancialOverview: vi.fn(),
  refetchCompanyAccounts: vi.fn(),
  smsQuotaError: false,
  subaccountQuotaError: false,
  refetchBranchPolicy: vi.fn(),
  refetchSmsQuota: vi.fn(),
  requestSmsPackage: vi.fn(),
  smsPackageRequestError: false,
  refetchSmsPackageRequest: vi.fn(),
  refetchSubaccountQuota: vi.fn(),
}));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: state.isAuthenticated, loading: state.authLoading, user: state.user }) }));
vi.mock("@/components/DashboardLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/MetricCard", () => ({ MetricCard: ({ label, value }: { label: string; value: string }) => <div>{label}: {value}</div> }));
vi.mock("@/hooks/useBranchFilter", () => ({ useBranchFilter: () => ({ branchId: 1, setBranchId: vi.fn() }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/workspace", state.setLocation] }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    powerhub: {
      sites: { list: { useQuery: () => ({ data: [{ id: 1, name: "فرع الاختبار" }], isLoading: false, isError: false }) }, branchPolicy: { useQuery: () => ({ data: state.branchPolicy, isLoading: false, isError: state.branchPolicyError, refetch: state.refetchBranchPolicy }) } },
      readingCycle: { currentBounds: { useQuery: () => ({ data: { cycleKey: "2026-10", cycleLabel: "أكتوبر 2026", billingPeriod: "2026-10", startAt: "2026-10-01T00:00:00.000Z", endAt: "2026-10-31T20:59:59.999Z" }, isLoading: false, isError: false, refetch: vi.fn() }) }, boundsAt: { useQuery: () => ({ data: { cycleKey: "2026-09", cycleLabel: "سبتمبر 2026", billingPeriod: "2026-09", startAt: "2026-09-01T00:00:00.000Z", endAt: "2026-09-30T20:59:59.999Z" }, isLoading: false, isError: false, refetch: vi.fn() }) } },
      dashboard: { summary: { useQuery: () => ({ data: { failedNotifications: 0 }, isLoading: false, isError: false, refetch: vi.fn() }) }, allBranchesSummary: { useQuery: () => ({ data: { branchSummaries: [] }, isLoading: false, isError: false, refetch: vi.fn() }) }, financialOverview: { useQuery: (_input: unknown, options?: { enabled?: boolean }) => { state.financialOverviewEnabled = Boolean(options?.enabled); return { data: { month: { invoiced: 0, collected: 0, collectionRate: 0, netCash: 0, expenses: 0 }, today: { invoiced: 0, collected: 0, collectionRate: 0 }, outstanding: { total: 0, accountCount: 0, overdue: 0, partialInvoices: 0 }, period: { month: "أغسطس" }, branchSummaries: [], topDebtors: [], trend: [] }, isLoading: false, isError: state.financialOverviewError, refetch: state.refetchFinancialOverview }; } }, periodMetrics: { useQuery: (input: { siteId: number; scope: "branch" | "all"; startDate: string; endDate: string }, options?: { enabled?: boolean }) => { state.periodMetricsEnabled = Boolean(options?.enabled); return { data: { range: { startDate: input.startDate, endDate: input.endDate }, scope: input.scope, summary: { invoiced: 0, collected: 0, collectionRate: 0, outstanding: 0, overdue: 0, overdueInvoiceCount: 0, overdueSubscriberCount: 0 }, outstandingInvoices: [] }, isLoading: false, isError: state.financialOverviewError, refetch: vi.fn() }; } } },
      performance: {
        readingKpis: { useQuery: () => ({ data: { consumption: 0, average: 0, approvedCount: 0, pendingCount: 0, latestReadingAt: null }, isLoading: false, isError: false }) },
        allBranchesReadingKpis: { useQuery: () => ({ data: { consumption: 0, average: 0, approvedCount: 0, pendingCount: 0, latestReadingAt: null }, isLoading: false, isError: false }) },
        collectorPerformance: { useQuery: () => ({ data: { openCount: 0, closedCount: 0, varianceCount: 0, netVariance: 0, collectors: [] }, isLoading: false, isError: false }) },
        allBranchesCollectorPerformance: { useQuery: () => ({ data: { openCount: 0, closedCount: 0, varianceCount: 0, netVariance: 0, collectors: [] }, isLoading: false, isError: false }) },
      },
      publicPackageCatalog: { useQuery: () => ({ data: { packages: [{ code: "basic", active: true }, { code: "advanced", active: true }, { code: "professional", active: true }, { code: "business", active: true }, { code: "vip", active: true }] }, isLoading: false, isError: false }) },
      companyAccounts: { list: { useQuery: () => ({ data: [], isLoading: false, isError: state.companyAccountsError, refetch: state.refetchCompanyAccounts }) } },
      subscribers: { quota: { useQuery: () => ({ data: state.subscriberQuota, isLoading: false, isError: false, refetch: vi.fn() }) } },
      staff: { myAccess: { useQuery: () => ({ data: { role: state.accessRole } }) }, allBranchAccess: { useQuery: () => ({ data: { isGlobal: false } }) }, allowedSubaccountRoles: { useQuery: () => ({ data: { limit: 5, currentCount: 2, fieldUserLimit: 2, fieldUserCount: 1 }, isLoading: false, isError: state.subaccountQuotaError, refetch: state.refetchSubaccountQuota }) } },
      messaging: { smsQuota: { useQuery: () => ({ data: { total: 500, used: state.smsUsed, remaining: Math.max(0, 500 - state.smsUsed), senderName: "PowerHub", configured: state.configured, isActive: state.isActive, lastError: null, providerMonthlyLimit: 2000, providerMonthlyUsed: 90 }, isLoading: false, isError: state.smsQuotaError, refetch: state.refetchSmsQuota }) }, smsCreditPackages: { useQuery: () => ({ data: [{ id: 11, code: "sms-1000", name: "حزمة 1000 رسالة", messages: 1000, price: 0, currency: "ILS" }], isLoading: false, isError: false }) }, currentSmsPackageRequest: { useQuery: () => ({ data: null, isLoading: false, isError: state.smsPackageRequestError, refetch: state.refetchSmsPackageRequest }) }, requestSmsPackage: { useMutation: () => ({ mutate: state.requestSmsPackage, isPending: false }) } },
      subscription: { ownerRenewalStatus: { useQuery: () => ({ data: { isOwner: false, subscription: null }, isLoading: false, isError: false, refetch: vi.fn() }) }, currentUpgradeRequest: { useQuery: () => ({ data: null }) }, currentAddonRequests: { useQuery: () => ({ data: [] }) }, requestUpgrade: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) }, requestAddon: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } },
    },
  },
}));

afterEach(() => {
  state.authLoading = false;
  state.isAuthenticated = true;
  state.user = { id: 4, role: "user", mustChangePassword: false };
  state.accessRole = "owner";
  state.financialOverviewEnabled = true;
  state.periodMetricsEnabled = true;
  state.setLocation.mockReset();
  state.configured = true;
  state.isActive = true;
  state.remaining = 458;
  state.branchPolicy = { isEnabled: true, maxBranches: 3, currentCount: 1, remaining: 2 };
  state.subscriberQuota = { limit: 100, currentCount: 25, remaining: 75, plan: "basic" };
  state.smsUsed = 42;
  state.branchPolicyError = false;
  state.financialOverviewError = false;
  state.companyAccountsError = false;
  state.refetchFinancialOverview.mockReset();
  state.refetchCompanyAccounts.mockReset();
  state.smsQuotaError = false;
  state.smsPackageRequestError = false;
  state.refetchSmsPackageRequest.mockReset();
  state.subaccountQuotaError = false;
  state.refetchBranchPolicy.mockReset();
  state.refetchSmsQuota.mockReset();
  state.requestSmsPackage.mockReset();
  state.refetchSubaccountQuota.mockReset();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("تهيئة مصادقة مساحة العمل", () => {
  it("keeps the workspace in a verification state while auth is loading instead of redirecting prematurely", () => {
    state.authLoading = true;
    state.isAuthenticated = false;
    state.user = null;

    render(<WorkspaceHome />);

    expect(screen.getByText("جارٍ التحقق من جلسة الدخول…")).toBeInTheDocument();
    expect(state.setLocation).not.toHaveBeenCalledWith("/login");
  });

  it("redirects to login only after auth loading has completed and no authenticated user exists", () => {
    state.authLoading = false;
    state.isAuthenticated = false;
    state.user = null;

    render(<WorkspaceHome />);

    expect(screen.getByText("جارٍ توجيهك إلى تسجيل الدخول…")).toBeInTheDocument();
  });
});

describe("إشعارات حدود الاشتراك في لوحة المالك", () => {
  it("يُبقي بطاقة استهلاك حد الأفرع مخفية حتى عند استنفاد الحصة دون إطلاق Toast", async () => {
    const { toast } = await import("sonner");
    state.branchPolicy = { isEnabled: true, maxBranches: 1, currentCount: 1, remaining: 0 };
    render(<WorkspaceHome />);
    expect(screen.queryByText("بلغت الحد الأقصى للأفرع المتاحة.")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "استهلاك حصة الأفرع" })).not.toBeInTheDocument();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("يعرض بطاقات حدود المشتركين والرسائل مع إبقاء بطاقة حد الأفرع مخفية ودون Toast عام", async () => {
    const { toast } = await import("sonner");
    state.branchPolicy = { isEnabled: true, maxBranches: 3, currentCount: 3, remaining: 0 };
    state.subscriberQuota = { limit: 100, currentCount: 85, remaining: 15, plan: "basic" };
    state.smsUsed = 450;
    render(<WorkspaceHome />);
    expect(screen.getByText("استهلكت 85% من الحد المسموح. اقتربت من الحد الأقصى.")).toBeInTheDocument();
    expect(screen.queryByText("بلغت الحد الأقصى للأفرع المتاحة.")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "استهلاك حصة الأفرع" })).not.toBeInTheDocument();
    expect(screen.getByText("محفظة رسائل SMS")).toBeInTheDocument();
    expect(screen.getByText("حد مزود الرسائل الشهري")).toBeInTheDocument();
    expect(screen.queryByText("تحتاج إلى رصيد رسائل إضافي؟")).not.toBeInTheDocument();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("يطلب صاحب المولد حزمة من الكتالوج عبر معرّف الحزمة دون إدخال كمية حرة", () => {
    state.smsUsed = 450;
    render(<WorkspaceHome />);
    expect(screen.getByText("شراء حزمة رسائل مستقلة")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "طلب هذه الحزمة" }));
    expect(state.requestSmsPackage).toHaveBeenCalledWith({ siteId: 1, packageId: 11, note: undefined });
  });

  it("يعرض إعادة المحاولة ويمنع طلب حزمة أخرى إذا تعذر تحميل حالة الطلب", () => {
    state.smsUsed = 450;
    state.smsPackageRequestError = true;
    render(<WorkspaceHome />);
    expect(screen.getByText("تعذر التحقق من الطلب السابق؛ أعد المحاولة قبل طلب جديد.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "حزمة رصيد SMS" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
    expect(state.refetchSmsPackageRequest).toHaveBeenCalledTimes(1);
    expect(state.requestSmsPackage).not.toHaveBeenCalled();
  });

  it("لا يعتبر فشل تحميل سياسة الأفرع نفاداً للحصة ويوفر إعادة المحاولة", async () => {
    const { toast } = await import("sonner");
    state.branchPolicyError = true;
    render(<WorkspaceHome />);
    expect(screen.getByRole("alert")).toHaveTextContent("تعذر تحميل بيانات بعض الحصص");
    expect(screen.getByRole("alert")).toHaveTextContent("الأفرع");
    expect(screen.queryByText("بلغت الحد الأقصى للأفرع المتاحة.")).not.toBeInTheDocument();
    expect(toast.warning).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
    expect(state.refetchBranchPolicy).toHaveBeenCalledTimes(1);
  });

});

describe("بطاقة رصيد SMS في لوحة المالك", () => {
  it("تعرض الرصيد الدائم والمستهلك وحد مزود الرسائل بشكل منفصل", () => {
    render(<WorkspaceHome />);
    expect(screen.getByText("محفظة رسائل SMS")).toBeInTheDocument();
    expect(screen.getByText("PowerHub")).toBeInTheDocument();
    expect(screen.getByText(/رصيد الرسائل متاح/)).toBeInTheDocument();
    expect(screen.getByText(/رصيد مدفوع دائم لا تنتهي صلاحيته/)).toBeInTheDocument();
    expect(screen.getByText("حد مزود الرسائل الشهري")).toBeInTheDocument();
    expect(screen.queryByText(/الحصة الشهرية للفرع المحدد/)).not.toBeInTheDocument();
  });

  it("لا يعرض أرصدة حسابات الشركة كصفر عند فشل التحميل ويوفر إعادة المحاولة", () => {
    state.companyAccountsError = true;
    render(<WorkspaceHome />);
    expect(screen.getByRole("alert")).toHaveTextContent("تعذر تحميل أرصدة حسابات الشركة");
    expect(screen.queryByText("إجمالي السيولة المتاحة")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
    expect(state.refetchCompanyAccounts).toHaveBeenCalledTimes(1);
  });

  it("لا يحول فشل تحميل الملخص المالي إلى أصفار أو إلى رسالة لا توجد أرصدة", () => {
    state.financialOverviewError = true;
    render(<WorkspaceHome />);
    expect(screen.getByRole("alert")).toHaveTextContent("تعذر تحميل بعض بيانات لوحة التحكم");
    expect(screen.getByText("تعذر تحميل أولوية المتأخرات. أعد تحميل مؤشرات لوحة التحكم.")).toBeInTheDocument();
    expect(screen.queryByText("لا توجد أرصدة مفتوحة ضمن النطاق الحالي.")).not.toBeInTheDocument();
    expect(screen.getByText("فوترة الفترة: —")).toBeInTheDocument();
    expect(screen.getByText("نتيجة اليوم")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(2);
  });

  it("لا يطلب الملخص المالي ولا مؤشرات الفترة للأدوار التي لا يسمح لها الخادم بقراءتها", () => {
    state.accessRole = "technician";
    render(<WorkspaceHome />);
    expect(state.financialOverviewEnabled).toBe(false);
    expect(state.periodMetricsEnabled).toBe(false);
    expect(screen.queryByText("تعذر تحميل بعض بيانات لوحة التحكم")).not.toBeInTheDocument();
  });

  it("يبقي لوحة التحكم مخصصة للمؤشرات ولا يكرر لوحة اختصارات مالية منفصلة", () => {
    render(<WorkspaceHome />);
    expect(screen.getByRole("button", { name: /الإجراءات السريعة/ })).toBeInTheDocument();
    expect(screen.queryByText("إجراءات مالية سريعة", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("إضافة مشترك", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("تسجيل تحصيل", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("فتح قائمة التحصيل ذات الأولوية", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("مراجعة الفواتير", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("فتح التقرير المالي", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("حدود حسابات الفريق والميدان")).toBeInTheDocument();
    expect(screen.queryByText("حدود الاشتراك واستهلاكها", { exact: true })).not.toBeInTheDocument();
  });

  it("يوضح أن الإرسال غير مهيأ دون إظهار أي بيانات اعتماد", () => {
    state.configured = false;
    render(<WorkspaceHome />);
    expect(screen.getByText("حساب TweetSMS غير مهيأ")).toBeInTheDocument();
    expect(screen.queryByText(/credential_ciphertext|credential_iv|api_endpoint|مفتاح API/i)).not.toBeInTheDocument();
  });
});