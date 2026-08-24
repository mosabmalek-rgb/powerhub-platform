// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import QuickActionsPage from "./QuickActionsPage";

const state = vi.hoisted(() => ({
  access: { role: "owner", permissions: [] as string[] },
  setLocation: vi.fn(),
}));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: 9, role: "user" } }) }));
vi.mock("@/components/DashboardLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/hooks/useBranchFilter", () => ({ useBranchFilter: () => ({ branchId: 1, setBranchId: vi.fn() }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/quick-actions", state.setLocation] }));
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    powerhub: {
      sites: { list: { useQuery: () => ({ data: [{ id: 1, name: "فرع الاختبار" }], isLoading: false }) } },
      staff: { myAccess: { useQuery: () => ({ data: state.access, isLoading: false }) } },
    },
  },
}));

afterEach(() => { state.access = { role: "owner", permissions: [] }; state.setLocation.mockReset(); document.body.innerHTML = ""; });

describe("شاشة الإجراءات السريعة", () => {
  it("تجمع الإجراءات التشغيلية الرئيسية وتفتح التحصيل ضمن المسار الصحيح", () => {
    render(<QuickActionsPage />);
    expect(screen.getByRole("heading", { name: "الإجراءات السريعة" })).toBeInTheDocument();
    expect(screen.getByText("إضافة مشترك")).toBeInTheDocument();
    expect(screen.getByText("تسجيل قراءة")).toBeInTheDocument();
    expect(screen.getByText("إنشاء فاتورة")).toBeInTheDocument();
    expect(screen.getByText("تحصيل دين")).toBeInTheDocument();
    expect(screen.getByText("تسجيل مصروف")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /تحصيل دين/ }));
    expect(state.setLocation).toHaveBeenCalledWith("/collections");
  });

  it("يعرض للمحصل الإجراء المصرح به فقط دون فتح إدارة الفواتير أو المشتركين", () => {
    state.access = { role: "collector", permissions: ["collectPayments"] };
    render(<QuickActionsPage />);
    expect(screen.getByText("تحصيل دين")).toBeInTheDocument();
    expect(screen.queryByText("إضافة مشترك")).not.toBeInTheDocument();
    expect(screen.queryByText("تسجيل قراءة")).not.toBeInTheDocument();
    expect(screen.queryByText("إنشاء فاتورة")).not.toBeInTheDocument();
  });
});
