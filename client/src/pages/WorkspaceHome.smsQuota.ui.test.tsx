// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceHome } from "./Home";

const state = vi.hoisted(() => ({
  configured: true,
  isActive: true,
  remaining: 458,
  branchPolicy: { isEnabled: true, maxBranches: 3, currentCount: 1, remaining: 2 },
  subscriberQuota: { limit: 100, currentCount: 25, remaining: 75, plan: "basic" },
  smsUsed: 42,
  branchPolicyError: false,
  smsQuotaError: false,
  subaccountQuotaError: false,
  refetchBranchPolicy: vi.fn(),
  refetchSmsQuota: vi.fn(),
  requestSmsPackage: vi.fn(),
  smsPackageRequestError: false,
  refetchSmsPackageRequest: vi.fn(),
  refetchSubaccountQuota: vi.fn(),
}));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: true, loading: false, user: { id: 4, role: "user", mustChangePassword: false } }) }));
vi.mock("@/components/DashboardLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/MetricCard", () => ({ MetricCard: ({ label, value }: { label: string; value: string }) => <div>{label}: {value}</div> }));
vi.mock("@/hooks/useBranchFilter", () => ({ useBranchFilter: () => ({ branchId: 1, setBranchId: vi.fn() }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/workspace", vi.fn()] }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    powerhub: {
      sites: { list: { useQuery: () => ({ data: [{ id: 1, name: "فرع الاختبار" }], isLoading: false, isError: false }) }, branchPolicy: { useQuery: () => ({ data: state.branchPolicy, isLoading: false, isError: state.branchPolicyError, refetch: state.refetchBranchPolicy }) } },
      dashboard: { summary: { useQuery: () => ({ data: { failedNotifications: 0 }, isLoading: false, isError: false, refetch: vi.fn() }) }, allBranchesSummary: { useQuery: () => ({ data: { branchSummaries: [] }, isLoading: false, isError: false, refetch: vi.fn() }) }, financialOverview: { useQuery: () => ({ data: { month: { invoiced: 0, collected: 0, collectionRate: 0, netCash: 0, expenses: 0 }, today: { invoiced: 0, collected: 0, collectionRate: 0 }, outstanding: { total: 0, accountCount: 0, overdue: 0, partialInvoices: 0 }, period: { month: "أغسطس" }, branchSummaries: [], topDebtors: [], trend: [] }, isLoading: false, isError: false, refetch: vi.fn() }) } },
      performance: {
        readingKpis: { useQuery: () => ({ data: { consumption: 0, average: 0, approvedCount: 0, pendingCount: 0, latestReadingAt: null }, isLoading: false, isError: false }) },
        collectorPerformance: { useQuery: () => ({ data: { openCount: 0, closedCount: 0, varianceCount: 0, netVariance: 0, collectors: [] }, isLoading: false, isError: false }) },
      },
      publicPackageCatalog: { useQuery: () => ({ data: { packages: [{ code: "basic", active: true }, { code: "advanced", active: true }, { code: "professional", active: true }, { code: "business", active: true }, { code: "vip", active: true }] }, isLoading: false, isError: false }) },
      companyAccounts: { list: { useQuery: () => ({ data: [] }) } },
      subscribers: { quota: { useQuery: () => ({ data: state.subscriberQuota, isLoading: false, isError: false, refetch: vi.fn() }) } },
      staff: { myAccess: { useQuery: () => ({ data: { role: "owner" } }) }, allBranchAccess: { useQuery: () => ({ data: { isGlobal: false } }) }, allowedSubaccountRoles: { useQuery: () => ({ data: { limit: 5, currentCount: 2, fieldUserLimit: 2, fieldUserCount: 1 }, isLoading: false, isError: state.subaccountQuotaError, refetch: state.refetchSubaccountQuota }) } },
      messaging: { smsQuota: { useQuery: () => ({ data: { total: 500, used: state.smsUsed, remaining: Math.max(0, 500 - state.smsUsed), senderName: "PowerHub", configured: state.configured, isActive: state.isActive, lastError: null }, isLoading: false, isError: state.smsQuotaError, refetch: state.refetchSmsQuota }) }, currentSmsPackageRequest: { useQuery: () => ({ data: null, isLoading: false, isError: state.smsPackageRequestError, refetch: state.refetchSmsPackageRequest }) }, requestSmsPackage: { useMutation: () => ({ mutate: state.requestSmsPackage, isPending: false }) } },
      subscription: { currentUpgradeRequest: { useQuery: () => ({ data: null }) }, currentAddonRequests: { useQuery: () => ({ data: [] }) }, requestUpgrade: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) }, requestAddon: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } },
    },
  },
}));

afterEach(() => {
  state.configured = true;
  state.isActive = true;
  state.remaining = 458;
  state.branchPolicy = { isEnabled: true, maxBranches: 3, currentCount: 1, remaining: 2 };
  state.subscriberQuota = { limit: 100, currentCount: 25, remaining: 75, plan: "basic" };
  state.smsUsed = 42;
  state.branchPolicyError = false;
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

describe("إشعارات حدود الاشتراك في لوحة المالك", () => {
  it("لا يعرض تحذير Toast تلقائياً عند فتح لوحة التحكم والحصة مستنفدة", async () => {
    const { toast } = await import("sonner");
    state.branchPolicy = { isEnabled: true, maxBranches: 1, currentCount: 1, remaining: 0 };
    render(<WorkspaceHome />);
    expect(screen.getByText("بلغت الحد الأقصى للأفرع المتاحة.")).toBeInTheDocument();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("يعرض حالات الحصص في بطاقاتها دون Toast عام عند تجاوز أكثر من حصة", async () => {
    const { toast } = await import("sonner");
    state.branchPolicy = { isEnabled: true, maxBranches: 3, currentCount: 3, remaining: 0 };
    state.subscriberQuota = { limit: 100, currentCount: 85, remaining: 15, plan: "basic" };
    state.smsUsed = 450;
    render(<WorkspaceHome />);
    expect(screen.getByText("استهلكت 85% من الحد المسموح. اقتربت من الحد الأقصى.")).toBeInTheDocument();
    expect(screen.getByText("بلغت الحد الأقصى للأفرع المتاحة.")).toBeInTheDocument();
    expect(screen.getByText("تحتاج إلى رصيد رسائل إضافي؟")).toBeInTheDocument();
    expect(screen.getAllByText("رصيد رسائل SMS", { exact: true })).toHaveLength(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("يتيح طلب حزمة SMS من داخل بطاقة الحصة دون تكرار بطاقة التنبيه", () => {
    state.smsUsed = 450;
    render(<WorkspaceHome />);
    expect(screen.getByText("تحتاج إلى رصيد رسائل إضافي؟")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "طلب حزمة 1000 رسالة" }));
    expect(state.requestSmsPackage).toHaveBeenCalledWith({ siteId: 1, requestedMessages: 1000, note: undefined });
  });

  it("يعرض إعادة محاولة لطلب SMS إذا تعذر تحميل حالة الحزمة ويمنع الطلب قبل التحقق", () => {
    state.smsUsed = 450;
    state.smsPackageRequestError = true;
    render(<WorkspaceHome />);
    expect(screen.getByText("تعذر التحقق من حالة طلب الحزمة الحالي. أعد المحاولة قبل إرسال طلب جديد.")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "عدد الرسائل المطلوبة" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "إعادة التحقق من الطلب" }));
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
  it("تعرض المتبقي والمستخدم والإجمالي واسم المرسل للحصة الحالية", () => {
    render(<WorkspaceHome />);
    expect(screen.getByText("رصيد رسائل SMS")).toBeInTheDocument();
    expect(screen.getByText("PowerHub")).toBeInTheDocument();
    expect(screen.getByText(/رصيد الرسائل متاح/)).toBeInTheDocument();
    expect(screen.getByText(/الحصة الشهرية للفرع المحدد/)).toBeInTheDocument();
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
    expect(screen.getByText(/لا تظهر مفاتيح API|من دون كشف مفتاح API/)).toBeInTheDocument();
  });
});