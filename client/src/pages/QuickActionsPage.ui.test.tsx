// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import QuickActionsPage from "./QuickActionsPage";

const state = vi.hoisted(() => ({
  access: { role: "owner", permissions: [] as string[] },
  preferences: [] as string[],
  setLocation: vi.fn(),
  savePreferences: vi.fn(),
  refetchPreferences: vi.fn(),
  refetchSites: vi.fn(),
  refetchAccess: vi.fn(),
  sitesError: false,
  accessError: false,
  preferencesError: false,
  preservePreferencesOnError: false,
  accessDenied: false,
  isOnline: true,
  isChecking: false,
}));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: 9, role: "user" } }) }));
vi.mock("@/components/DashboardLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/hooks/useBranchFilter", () => ({ useBranchFilter: () => ({ branchId: 1, setBranchId: vi.fn() }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/quick-actions", state.setLocation] }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/offline-connectivity", () => ({ usePowerHubConnectivity: () => ({ isOnline: state.isOnline, isChecking: state.isChecking, reconnectGeneration: 0 }) }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    powerhub: {
      sites: { list: { useQuery: () => ({ data: state.sitesError ? undefined : [{ id: 1, name: "فرع الاختبار" }], isLoading: false, isError: state.sitesError, error: state.sitesError ? new Error("فشل النقل") : undefined, refetch: state.refetchSites }) } },
      staff: { myAccess: { useQuery: () => ({ data: state.accessError || state.accessDenied ? undefined : state.access, isLoading: false, isError: state.accessError || state.accessDenied, error: state.accessDenied ? { data: { code: "FORBIDDEN" } } : state.accessError ? new Error("فشل النقل") : undefined, refetch: state.refetchAccess }) } },
      quickActions: { preferences: { useQuery: () => ({ data: state.preferencesError && !state.preservePreferencesOnError ? undefined : { actionIds: state.preferences }, isLoading: false, isError: state.preferencesError, error: state.preferencesError ? new Error("فشل النقل") : undefined, refetch: state.refetchPreferences }) }, savePreferences: { useMutation: () => ({ mutate: state.savePreferences, isPending: false }) } },
    },
  },
}));

afterEach(() => { state.access = { role: "owner", permissions: [] }; state.preferences = []; state.sitesError = false; state.accessError = false; state.preferencesError = false; state.preservePreferencesOnError = false; state.accessDenied = false; state.isOnline = true; state.isChecking = false; state.setLocation.mockReset(); state.savePreferences.mockReset(); state.refetchPreferences.mockReset(); state.refetchSites.mockReset(); state.refetchAccess.mockReset(); document.body.innerHTML = ""; });

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


  it("يعرض اختصارات قراءات الميدان وتوثيق الدفع ومركز الرسائل عند عدم وجودها في الإجراءات الأساسية", () => {
    state.preferences = ["collect_payment"];
    render(<QuickActionsPage />);
    expect(screen.getByRole("button", { name: /^مراجعة قراءات الميدان/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^توثيق الدفع/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /مراجعة توثيق الدفع/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /مركز الرسائل/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^مراجعة قراءات الميدان/ }));
    expect(state.setLocation).toHaveBeenLastCalledWith("/mobile-sync");
    fireEvent.click(screen.getByRole("button", { name: /^توثيق الدفع/ }));
    expect(state.setLocation).toHaveBeenLastCalledWith("/payment-documentation");
    fireEvent.click(screen.getByRole("button", { name: /مراجعة توثيق الدفع/ }));
    expect(state.setLocation).toHaveBeenLastCalledWith("/payment-documentation/review");
    fireEvent.click(screen.getByRole("button", { name: /مركز الرسائل/ }));
    expect(state.setLocation).toHaveBeenLastCalledWith("/notifications");
  });

  it("يعرض اختصارات دورة الاشتراك ويربط البحث والمتأخرات والتذكير والاعتماد بمساراتها الفعلية", () => {
    state.preferences = ["collect_payment"];
    render(<QuickActionsPage />);
    const expected = [
      ["البحث وتعديل بيانات المشترك", "/subscribers?subscriberFocus=1"],
      ["متابعة المتأخرات", "/subscribers?debtorFocus=1&debtorStatus=overdue"],
      ["إرسال تذكير بالسداد", "/subscribers?debtorFocus=1&debtorStatus=overdue"],
      ["مراجعة قراءات الميدان", "/mobile-sync"],
      ["اعتماد القراءات الميدانية المعلقة", "/mobile-sync?focus=pending"],
    ] as const;
    for (const [label, path] of expected) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
      expect(state.setLocation).toHaveBeenLastCalledWith(path);
    }
  });

  it("لا يكرر رابط الفواتير في اختصارات المتابعة إذا كان إجراء الفاتورة ظاهرًا", () => {
    state.preferences = ["create_invoice", "collect_payment"];
    render(<QuickActionsPage />);
    expect(screen.getByRole("button", { name: /إنشاء فاتورة/ })).toBeInTheDocument();
    expect(screen.queryByText("الفواتير", { exact: true })).not.toBeInTheDocument();
  });

  it("يبقي اختصار مراجعة الفواتير عندما لا يختار المستخدم إجراء إنشاء الفاتورة", () => {
    state.preferences = ["collect_payment"];
    render(<QuickActionsPage />);
    expect(screen.getByRole("button", { name: /تحصيل دين/ })).toBeInTheDocument();
    expect(screen.getByText("الفواتير", { exact: true })).toBeInTheDocument();
  });

  it("لا يعرض إجراءات بديلة عند فشل تحميل التفضيلات ويوفر إعادة المحاولة", () => {
    state.preferencesError = true;
    render(<QuickActionsPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("لم نعرض اختصارات افتراضية");
    expect(screen.getByRole("button", { name: "تخصيص اختصاراتي" })).toBeDisabled();
    expect(screen.queryByText("إضافة مشترك", { exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
    expect(state.refetchSites).toHaveBeenCalled();
    expect(state.refetchAccess).toHaveBeenCalled();
    expect(state.refetchPreferences).toHaveBeenCalled();
  });

  it("يخفي اختصارات المتابعة التي لا يملك الحساب صلاحيتها", () => {
    state.access = { role: "collector", permissions: ["collectPayments"] };
    render(<QuickActionsPage />);
    expect(screen.getByText("الفواتير")).toBeInTheDocument();
    expect(screen.queryByText("حسابات الشركة")).not.toBeInTheDocument();
    expect(screen.queryByText("التقرير المالي")).not.toBeInTheDocument();
    expect(screen.queryByText("الحسابات الفرعية")).not.toBeInTheDocument();
  });

  it("يوصل كل إجراء أساسي إلى التبويب المتخصص الصحيح", () => {
    const destinations = [
      ["إضافة مشترك", "/subscribers?add=1"],
      ["تسجيل قراءة", "/readings"],
      ["إنشاء فاتورة", "/invoices"],
      ["تحصيل دين", "/collections"],
      ["تسجيل مصروف", "/expenses"],
      ["مركز الرسائل", "/notifications"],
    ] as const;
    state.setLocation.mockClear();
    render(<QuickActionsPage />);
    for (const [label, path] of destinations) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
      expect(state.setLocation).toHaveBeenLastCalledWith(path);
    }
    expect(state.setLocation).toHaveBeenCalledTimes(destinations.length);
  });

  it("يحفظ إعادة ترتيب الاختصارات بالترتيب الجديد", () => {
    state.preferences = ["collect_payment", "add_subscriber"];
    render(<QuickActionsPage />);
    fireEvent.click(screen.getByRole("button", { name: "تخصيص اختصاراتي" }));
    fireEvent.click(screen.getByRole("button", { name: "رفع إضافة مشترك" }));
    fireEvent.click(screen.getByRole("button", { name: "حفظ اختصاراتي" }));
    expect(state.savePreferences).toHaveBeenCalledWith({ siteId: 1, actionIds: ["add_subscriber", "collect_payment"] });
  });

  it("تطابق اختصارات التقارير وحسابات الشركة الأدوار المسموح بها في القائمة الجانبية", () => {
    state.access = { role: "manager", permissions: [] };
    render(<QuickActionsPage />);
    expect(screen.getByText("حسابات الشركة")).toBeInTheDocument();
    expect(screen.getByText("التقرير المالي")).toBeInTheDocument();
    expect(screen.getByText("الفواتير")).toBeInTheDocument();
  });

  it("يعرض التفضيلات المحفوظة ويمكّن المستخدم من تعديلها وحفظها", () => {
    state.preferences = ["collect_payment", "add_subscriber"];
    render(<QuickActionsPage />);
    expect(screen.getByText("تحصيل دين")).toBeInTheDocument();
    expect(screen.getByText("إضافة مشترك")).toBeInTheDocument();
    expect(screen.queryByText("تسجيل مصروف")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "تخصيص اختصاراتي" }));
    fireEvent.click(screen.getByRole("button", { name: "إضافة تسجيل مصروف" }));
    fireEvent.click(screen.getByRole("button", { name: "حفظ اختصاراتي" }));
    expect(state.savePreferences).toHaveBeenCalledWith({ siteId: 1, actionIds: ["collect_payment", "add_subscriber", "record_expense"] });
  });

  it("shows only safe recovery links when opened offline without a permission snapshot", () => {
    state.isOnline = false;
    state.isChecking = false;
    state.accessError = true;
    state.preferencesError = true;
    render(<QuickActionsPage />);
    expect(screen.getByRole("heading", { name: "مسارات آمنة أثناء انقطاع الاتصال" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "مركز المسودات دون اتصال" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "العودة إلى لوحة التحكم" })).toBeInTheDocument();
    expect(screen.queryByText("إضافة مشترك", { exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "مركز المسودات دون اتصال" }));
    expect(state.setLocation).toHaveBeenLastCalledWith("/offline-sync");
  });

  it("preserves an already-loaded session snapshot during transient failure but disables offline edits", () => {
    state.isOnline = false;
    state.preferencesError = true;
    state.preservePreferencesOnError = true;
    state.preferences = ["collect_payment"];
    render(<QuickActionsPage />);
    expect(screen.getByRole("status")).toHaveTextContent("سبق تحميلها في هذه الجلسة");
    expect(screen.getByText("تحصيل دين")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تخصيص اختصاراتي" })).toBeDisabled();
  });

  it("does not fall back to safe recovery after an explicit server denial", () => {
    state.isOnline = false;
    state.accessDenied = true;
    render(<QuickActionsPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("رفض الخادم الوصول إلى هذا الفرع");
    expect(screen.queryByRole("heading", { name: "مسارات آمنة أثناء انقطاع الاتصال" })).not.toBeInTheDocument();
    expect(screen.queryByText("إضافة مشترك", { exact: true })).not.toBeInTheDocument();
  });
});
