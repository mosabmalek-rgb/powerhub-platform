// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminConsolePage from "./AdminConsolePage";

const state = vi.hoisted(() => ({ role: "user", mutation: vi.fn() }));
const ownerRow = {
  tenant: { id: 9, name: "مساحة مولد الاختبار", plan: "professional" },
  owner: { fullName: "صاحب المولد التجريبي", phone: "0790000000", ownerUserId: 4 },
  subscription: { status: "active", plan: "professional", billingCycle: "monthly", endsAt: new Date("2026-12-31"), autoRenew: true, notes: "" },
  subscribers: { residential: 120, commercial: 30, total: 150 },
};

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: true, loading: false, user: { id: 1, role: state.role, name: "آدمن الاختبار" } }) }));
vi.mock("@/components/DashboardLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ admin: { overview: { invalidate: vi.fn() }, listOwners: { invalidate: vi.fn() }, userDirectory: { invalidate: vi.fn() }, platformSnapshot: { invalidate: vi.fn() }, listNotifications: { invalidate: vi.fn() }, securityCenter: { invalidate: vi.fn() } } }),
    admin: {
      overview: { useQuery: () => ({ data: { totals: { generatorOwners: 1, residential: 120, commercial: 30, subscribers: 150, activeSubscriptions: 1 }, owners: [ownerRow] } }) },
      listOwners: { useQuery: () => ({ data: [ownerRow] }) },
      userDirectory: { useQuery: () => ({ data: [{ id: 4, name: "حساب صاحب المولد", email: "owner@example.com", role: "user" }] }) },
      platformSnapshot: { useQuery: () => ({ data: { generators: { total: 2, active: 2, maintenance: 0, stopped: 0, blocked: 0, capacityKw: 200, directory: [{ id: 22, name: "مولد اختبار", code: "GEN-T-01", status: "active", ratedCapacityKw: "100", tenantName: "مساحة مولد الاختبار", siteName: "محطة الاختبار" }], pendingRegistrations: [] }, users: { total: 3, platformAdmins: 1, activeStaff: 1, staffDirectory: [{ id: 7, userName: "محاسب الاختبار", userEmail: "accountant@example.com", role: "accountant", isActive: true, tenantName: "مساحة مولد الاختبار", siteName: "محطة الاختبار" }], subscriberDirectory: [{ id: 6, fullName: "مشترك تجريبي", subscriberNo: "SUB-01", subscriptionType: "residential", serviceStatus: "active", tenantName: "مساحة مولد الاختبار", siteName: "محطة الاختبار" }] }, finance: { overdueCount: 0, overdueAmount: 0, issuedAmount: 5000, completedAmount: 4000, completedCount: 2, paymentMethods: [{ method: "wallet", count: 2, amount: 4000 }], collectionsByGenerator: [{ generatorId: 22, generatorName: "مولد اختبار", generatorCode: "GEN-T-01", tenantName: "مساحة مولد الاختبار", count: 2, amount: 4000 }] }, reports: { approvedReadings: 0, consumptionKwh: 0, tenants: 1, subscribers: 150, complaintsEnabled: false }, notifications: { statuses: [{ status: "pending", count: 1 }] }, security: { recentAudit: [{ id: 1, action: "test_audit", tenantName: "مساحة مولد الاختبار", siteName: "محطة الاختبار", userName: "آدمن الاختبار", createdAt: new Date() }] } } }) },
      listNotifications: { useQuery: () => ({ data: [{ id: 1, tenantName: "مساحة مولد الاختبار", channel: "whatsapp", eventType: "invoice_issued", recipient: "0790000000", status: "pending", attempts: 0, createdAt: new Date() }] }) },
      securityCenter: { useQuery: () => ({ data: { events: [{ id: 1, eventType: "backup", severity: "info", status: "success", title: "نسخة اختبار", details: "تمت بنجاح", createdAt: new Date() }], settings: [{ id: 1, settingKey: "platform_audit_guard", isEnabled: true, value: null }] } }) },
      createGeneratorOwner: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      updateSubscription: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      renewSubscription: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      attachOwnerUser: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      setGeneratorStatus: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      recordSecurityEvent: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      saveSecuritySetting: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
    },
  },
}));

afterEach(() => { document.body.innerHTML = ""; state.role = "user"; state.mutation.mockReset(); });

describe("PowerHub platform administration UI", () => {
  it("hides the platform-wide console from a tenant user", () => {
    render(<AdminConsolePage />);
    expect(screen.getByText("هذه الصفحة مخصصة لآدمن PowerHub")).toBeInTheDocument();
    expect(screen.queryByText("أصحاب المولدات والاشتراكات")).not.toBeInTheDocument();
  });

  it("shows owner statistics and administration tabs to the platform admin", () => {
    state.role = "admin";
    render(<AdminConsolePage />);
    expect(screen.getByText("أصحاب المولدات والاشتراكات")).toBeInTheDocument();
    expect(screen.getByText("مشتركو السكان")).toBeInTheDocument();
    expect(screen.getAllByText("150").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "إدارة المستخدمين" }));
    expect(screen.getByText("إضافة صاحب مولد جديد")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "المالية والتحصيل" }));
    expect(screen.getByRole("button", { name: /تجديد دورة/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "التقارير" }));
    expect(screen.getByRole("button", { name: /تصدير CSV/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "إدارة المولدات" }));
    expect(screen.getByText("مولدات محظورة")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "التنبيهات" }));
    expect(screen.getByText("سجل الإشعارات")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "الأمان والسجلات" }));
    expect(screen.getByText("أحداث الأمان والنسخ الاحتياطي")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "إعدادات المنصة" }));
    expect(screen.getByText("إعدادات الحماية")).toBeInTheDocument();
  });

  it("renders central operational data and controlled states in every platform tab", () => {
    state.role = "admin";
    render(<AdminConsolePage />);
    fireEvent.click(screen.getByRole("button", { name: "إدارة المولدات" }));
    expect(screen.getByText("مولد اختبار")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "حظر المولد" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "إدارة المستخدمين" }));
    expect(screen.getByText("محاسب الاختبار")).toBeInTheDocument();
    expect(screen.getByText("مشترك تجريبي")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "المالية والتحصيل" }));
    expect(screen.getByText("طرق الدفع الإلكتروني")).toBeInTheDocument();
    expect(screen.getAllByText("مولد اختبار").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "التنبيهات" }));
    expect(screen.getByText("مساحة مولد الاختبار")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "الإرسال الجماعي مؤجل" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "الأمان والسجلات" }));
    expect(screen.getByText("نسخة اختبار")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تسجيل الحدث" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "إعدادات المنصة" }));
    expect(screen.getByText("platform_audit_guard")).toBeInTheDocument();
  });
});
