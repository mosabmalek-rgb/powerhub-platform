// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceHome } from "./Home";

const state = vi.hoisted(() => ({ configured: true, isActive: true, remaining: 458 }));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: true, loading: false, user: { id: 4, role: "user", mustChangePassword: false } }) }));
vi.mock("@/components/DashboardLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/MetricCard", () => ({ MetricCard: ({ label, value }: { label: string; value: string }) => <div>{label}: {value}</div> }));
vi.mock("@/components/SubscriberQuotaDashboardCard", () => ({ SubscriberQuotaDashboardCard: () => <div>حصة المشتركين</div> }));
vi.mock("@/hooks/useBranchFilter", () => ({ useBranchFilter: () => ({ branchId: 1, setBranchId: vi.fn() }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/workspace", vi.fn()] }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    powerhub: {
      sites: { list: { useQuery: () => ({ data: [{ id: 1, name: "فرع الاختبار" }] }) }, branchPolicy: { useQuery: () => ({ data: { isEnabled: true, maxBranches: 3, currentCount: 1, remaining: 2 }, isLoading: false }) } },
      dashboard: { summary: { useQuery: () => ({ data: { failedNotifications: 0 } }) }, financialOverview: { useQuery: () => ({ data: { month: { invoiced: 0, collected: 0, collectionRate: 0, netCash: 0, expenses: 0 }, today: { invoiced: 0, collected: 0, collectionRate: 0 }, outstanding: { total: 0, accountCount: 0, overdue: 0, partialInvoices: 0 }, period: { month: "أغسطس" }, branchSummaries: [], topDebtors: [], trend: [] } }) } },
      performance: {
        readingKpis: { useQuery: () => ({ data: { consumption: 0, average: 0, approvedCount: 0, pendingCount: 0, latestReadingAt: null }, isLoading: false, isError: false }) },
        collectorPerformance: { useQuery: () => ({ data: { openCount: 0, closedCount: 0, varianceCount: 0, netVariance: 0, collectors: [] }, isLoading: false, isError: false }) },
      },
      companyAccounts: { list: { useQuery: () => ({ data: [] }) } },
      subscribers: { quota: { useQuery: () => ({ data: {} }) } },
      staff: { myAccess: { useQuery: () => ({ data: { role: "owner" } }) }, allBranchAccess: { useQuery: () => ({ data: { isGlobal: false } }) } },
      messaging: { smsQuota: { useQuery: () => ({ data: { total: 500, used: 42, remaining: state.remaining, senderName: "PowerHub", configured: state.configured, isActive: state.isActive, lastError: null }, isLoading: false }) }, smsDailyUsage: { useQuery: () => ({ data: { total: 500, used: 42, remaining: state.remaining }, isLoading: false }) }, currentSmsPackageRequest: { useQuery: () => ({ data: null, refetch: vi.fn() }) }, requestSmsPackage: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } },
      subscription: { currentUpgradeRequest: { useQuery: () => ({ data: null }) }, requestUpgrade: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } },
    },
  },
}));

afterEach(() => { state.configured = true; state.isActive = true; state.remaining = 458; document.body.innerHTML = ""; });

describe("بطاقة رصيد SMS في لوحة المالك", () => {
  it("تعرض المتبقي والمستخدم والإجمالي واسم المرسل للحصة الحالية", () => {
    render(<WorkspaceHome />);
    expect(screen.getByText("رصيد رسائل SMS")).toBeInTheDocument();
    expect(screen.getByText("PowerHub")).toBeInTheDocument();
    expect(screen.getByText(/رصيد الرسائل متاح/)).toBeInTheDocument();
    expect(screen.getByText(/الحصة الشهرية للفرع المحدد/)).toBeInTheDocument();
  });

  it("يوضح أن الإرسال غير مهيأ دون إظهار أي بيانات اعتماد", () => {
    state.configured = false;
    render(<WorkspaceHome />);
    expect(screen.getByText("حساب TweetSMS غير مهيأ")).toBeInTheDocument();
    expect(screen.getByText(/لا تظهر مفاتيح API|من دون كشف مفتاح API/)).toBeInTheDocument();
  });
});