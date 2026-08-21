// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceHome } from "./Home";
import PublicInvoice from "./PublicInvoice";
import ReportsPage from "./ReportsPage";

const state = vi.hoisted(() => ({
  user: undefined as { role: "admin" | "user"; platformRole?: "platform_owner" | "platform_admin" | "finance_admin" | null; mustChangePassword?: boolean } | undefined,
  setLocation: vi.fn(),
}));

const report = {
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
      sites: { list: { useQuery: () => ({ data: [{ id: 7, name: "محطة التقرير", code: "REPORT-01" }] }) } },
      dashboard: { summary: { useQuery: () => ({ data: { energyKwh: 42, subscribers: 3, financial: { collected: 100, outstanding: 25 }, generators: { active: 1, maintenance: 0 } } }) } },
      subscribers: { quota: { useQuery: () => ({ data: { plan: "starter", limit: 100, currentCount: 3, remaining: 97 } }) } },
      staff: { myAccess: { useQuery: () => ({ data: { role: "owner" } }) } },
      subscription: { currentUpgradeRequest: { useQuery: () => ({ data: null }) }, requestUpgrade: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } },
      reports: { range: { useQuery: () => ({ data: report }) } },
      invoices: {
        publicByToken: { useQuery: () => ({
          data: {
            invoice: { invoiceNo: "PH-PUBLIC-0001", billingPeriod: "2026-08", status: "issued", consumptionKwh: "42", balanceDue: "63" },
            subscriber: { fullName: "مستخدم الرابط العام" },
            lines: [{ id: 1, description: "استهلاك الكهرباء", amount: "63" }],
          },
          isLoading: false,
          isError: false,
        }) },
      },
    },
  },
}));

describe("supplemental PowerHub page review", () => {
  it("renders the public invoice through its share route without authentication", () => {
    render(<PublicInvoice />);
    expect(screen.getByText("فاتورة قابلة للمشاركة")).toBeInTheDocument();
    expect(screen.getByText(/مستخدم الرابط العام/)).toBeInTheDocument();
    expect(screen.getByText("PH-PUBLIC-0001")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /نسخ رابط الفاتورة/ })).toBeInTheDocument();
  });

  it("selects the tenant site and displays the report's operational and financial data", async () => {
    render(<ReportsPage />);
    expect(screen.getByText("محطة التقرير")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("المحصل التجريبي")).toBeInTheDocument());
    expect(screen.getByText("أعلى المتأخرات")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("تاريخ بداية التقرير"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("تاريخ نهاية التقرير"), { target: { value: "2026-07-31" } });
    expect(screen.getByLabelText("تاريخ بداية التقرير")).toHaveValue("2026-07-01");
    expect(screen.getByLabelText("تاريخ نهاية التقرير")).toHaveValue("2026-07-31");
    expect(screen.getByRole("button", { name: "CSV" })).toBeEnabled();
  });

  it("renders dashboard metrics for the selected tenant site", async () => {
    render(<WorkspaceHome />);
    expect(screen.getByRole("combobox", { name: "اختيار المحطة" })).toHaveValue("7");
    await waitFor(() => expect(screen.getByText("إجمالي التحصيل")).toBeInTheDocument());
    expect(screen.getByText("المولدات العاملة")).toBeInTheDocument();
  });

  it("routes a platform admin away from the generator workspace to the admin center", async () => {
    state.user = { role: "admin", platformRole: "platform_admin" };
    render(<WorkspaceHome />);

    await waitFor(() => expect(state.setLocation).toHaveBeenCalledWith("/admin"));
    state.user = undefined;
    state.setLocation.mockReset();
  });
});
