// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminConsolePage from "./AdminConsolePage";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

const state = vi.hoisted(() => ({ role: "user", mutation: vi.fn(), collectionRate: 80 as unknown }));
const ownerRow = {
  tenant: { id: 9, name: "مساحة مولد الاختبار", plan: "professional" },
  owner: { fullName: "صاحب المولد التجريبي", phone: "0790000000", ownerUserId: 4 },
  subscription: { id: 50, status: "active", packageCode: "professional", plan: "professional", billingCycle: "monthly", endsAt: new Date("2026-12-31"), autoRenew: true, notes: "" },
  subscribers: { residential: 120, commercial: 30, total: 150 },
};

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: true, loading: false, user: { id: 1, role: state.role, platformRole: state.role === "admin" ? "platform_admin" : null, accountStatus: "active", name: "آدمن الاختبار" } }) }));
vi.mock("@/components/DashboardLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ admin: { overview: { invalidate: vi.fn() }, listOwners: { invalidate: vi.fn() }, userDirectory: { invalidate: vi.fn() }, platformSnapshot: { invalidate: vi.fn() }, listNotifications: { invalidate: vi.fn() }, securityCenter: { invalidate: vi.fn() }, listSmsPlans: { invalidate: vi.fn() }, listSmsPackageRequests: { invalidate: vi.fn() }, listTweetSmsAccounts: { invalidate: vi.fn() }, getPlatformTweetSmsAccount: { invalidate: vi.fn() }, platformTweetSmsReport: { invalidate: vi.fn() }, listPlatformSmsFallbackProviders: { invalidate: vi.fn() }, listActiveTenantAddons: { invalidate: vi.fn() }, listTenantAddonRequests: { invalidate: vi.fn() }, advancedDashboard: { invalidate: vi.fn() }, globalSearch: { invalidate: vi.fn() }, listComplaints: { invalidate: vi.fn() }, listTariffPolicies: { invalidate: vi.fn() }, platformConfiguration: { invalidate: vi.fn() }, listTenantBranchSettings: { invalidate: vi.fn() }, listTenantFeatureEntitlements: { invalidate: vi.fn() }, rolePolicies: { invalidate: vi.fn() }, listSubscriptionUpgradeRequests: { invalidate: vi.fn() } } }),
    admin: {
      overview: { useQuery: () => ({ data: { totals: { generatorOwners: 1, residential: 120, commercial: 30, subscribers: 150, activeSubscriptions: 1 }, owners: [ownerRow] } }) },
      listOwners: { useQuery: () => ({ data: [ownerRow] }) },
      listSubscriptionUpgradeRequests: { useQuery: () => ({ data: [{ id: 51, tenantId: 9, tenantName: "مساحة مولد الاختبار", ownerName: "صاحب المولد التجريبي", ownerEmail: "owner@example.com", currentPlan: "basic", requestedPlan: "professional", status: "pending", note: null, createdAt: new Date(), reviewedAt: null }], isLoading: false }) },
      listActiveTenantAddons: { useQuery: () => ({ data: [] }) },
      listTenantAddonRequests: { useQuery: () => ({ data: [] }) },
      reviewTenantAddonRequest: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      reviewSubscriptionUpgradeRequest: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      quickUpgradeOwnerPlan: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      sendOwnerUsageAlert: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      userDirectory: { useQuery: () => ({ data: [{ id: 4, name: "حساب صاحب المولد", email: "owner@example.com", role: "user" }] }) },
      platformSnapshot: { useQuery: () => ({ data: { generators: { total: 2, active: 2, maintenance: 0, stopped: 0, blocked: 0, capacityKw: 200, directory: [{ id: 22, name: "مولد اختبار", code: "GEN-T-01", status: "active", ratedCapacityKw: "100", tenantName: "مساحة مولد الاختبار", siteName: "محطة الاختبار" }], pendingRegistrations: [] }, users: { total: 3, platformAdmins: 1, activeStaff: 1, staffDirectory: [{ id: 7, userName: "محاسب الاختبار", userEmail: "accountant@example.com", role: "accountant", isActive: true, tenantName: "مساحة مولد الاختبار", siteName: "محطة الاختبار" }], subscriberDirectory: [{ id: 6, fullName: "مشترك تجريبي", subscriberNo: "SUB-01", subscriptionType: "residential", serviceStatus: "active", tenantName: "مساحة مولد الاختبار", siteName: "محطة الاختبار" }] }, finance: { overdueCount: 0, overdueAmount: 0, issuedAmount: 5000, completedAmount: 4000, completedCount: 2, paymentMethods: [{ method: "wallet", count: 2, amount: 4000 }], collectionsByGenerator: [{ generatorId: 22, generatorName: "مولد اختبار", generatorCode: "GEN-T-01", tenantName: "مساحة مولد الاختبار", count: 2, amount: 4000 }] }, reports: { approvedReadings: 0, consumptionKwh: 0, tenants: 1, subscribers: 150, complaintsEnabled: false }, notifications: { statuses: [{ status: "pending", count: 1 }] }, security: { recentAudit: [{ id: 1, action: "test_audit", tenantName: "مساحة مولد الاختبار", siteName: "محطة الاختبار", userName: "آدمن الاختبار", createdAt: new Date() }] } } }) },
      listNotifications: { useQuery: () => ({ data: [{ id: 1, tenantName: "مساحة مولد الاختبار", channel: "whatsapp", eventType: "invoice_issued", recipient: "0790000000", status: "pending", attempts: 0, createdAt: new Date() }] }) },
      operationalMonitoring: { useQuery: () => ({ data: { health: [{ key: "database", label: "البيانات", state: "healthy", detail: "استجابة سليمة", count: 1, target: "reports" }, { key: "messaging", label: "الإرسال", state: "warning", detail: "رسالة بانتظار المعالجة", count: 1, target: "notifications" }, { key: "sync", label: "المزامنة", state: "healthy", detail: "سليمة", count: 0, target: "field_sync" }, { key: "security", label: "الأمان", state: "healthy", detail: "سليم", count: 0, target: "security" }], alerts: [] }, isLoading: false }) },
      securityCenter: { useQuery: () => ({ data: { events: [{ id: 1, eventType: "backup", severity: "info", status: "success", title: "نسخة اختبار", details: "تمت بنجاح", createdAt: new Date() }], settings: [{ id: 1, settingKey: "platform_audit_guard", isEnabled: true, value: null }] } }) },
      listSmsPlans: { useQuery: () => ({ data: [{ id: 1, code: "starter-sms", name: "باقة جوال الأساسية", includedMessages: 100, isActive: true, description: "اختبار" }] }) },
      listSmsPackageRequests: { useQuery: () => ({ data: [] }) },
      listTweetSmsAccounts: { useQuery: () => ({ data: [
        { id: 7, tenantId: 9, tenantName: "مساحة مولد الاختبار", ownerName: "صاحب المولد التجريبي", ownerPhone: "0790000000", apiEndpoint: "https://api.example.test", senderName: "MouldNorth", monthlyLimit: 500, usedThisMonth: 42, remaining: 458, providerBalance: 80, lastBalanceCheckedAt: new Date("2026-10-12T10:00:00.000Z"), isActive: true, configured: true, subscriptionStatus: "active", lastTestedAt: new Date("2026-10-12T10:00:00.000Z"), lastError: null, updatedAt: new Date() },
        { id: null, tenantId: 10, tenantName: "مساحة مولد جديد", ownerName: "مالك جديد", ownerPhone: "0790000010", apiEndpoint: null, senderName: null, monthlyLimit: 0, usedThisMonth: 0, remaining: 0, isActive: false, configured: false, subscriptionStatus: "active", lastTestedAt: null, lastError: null, updatedAt: null },
      ] }) },
      getPlatformTweetSmsAccount: { useQuery: () => ({ data: { id: 1, apiEndpoint: "https://tweetsms.ps", senderName: "PowerHub", lowBalanceThreshold: 100, lastProviderBalance: 80, lastBalanceCheckedAt: new Date(), lastTestedAt: new Date(), lastError: null, isActive: true, configured: true } }) },
      platformTweetSmsReport: { useQuery: () => ({ data: { account: null, total: 42, usageRows: [{ tenantId: 9, tenantName: "مساحة مولد الاختبار", total: 42, submitted: 40, failed: 2 }], alerts: [{ id: 1, balance: 80, threshold: 100, status: "open", notifiedAt: new Date() }] } }) },
      listPlatformSmsFallbackProviders: { useQuery: () => ({ data: [{ id: 13, name: "مزود بديل تجريبي", providerKey: "backup-sms", apiEndpoint: "https://backup.example.test", senderName: "PowerHub", priority: 10, integrationStatus: "pending_contract", isActive: true, configured: true, lastTestedAt: null, lastError: null, updatedAt: new Date() }] }) },
      ownerQuotaUsageReport: { useQuery: () => ({ data: [], isLoading: false }) },
      advancedDashboard: { useQuery: () => ({ data: { kpis: { activeGenerators: 2, subscribers: 150, dailyConsumption: 50, monthlyConsumption: 1000, monthlyCollections: 4000, openComplaints: 1, generatorsToReview: 0, collectionRate: state.collectionRate }, monthlyGrowth: [{ month: "2026-08", count: 150 }], consumptionByRegion: [{ region: "بغداد", consumptionKwh: 1000 }], collectionsByGenerator: [{ generatorId: 22, generatorName: "مولد اختبار", code: "GEN-T-01", tenantName: "مساحة مولد الاختبار", amount: 4000 }], latestGenerators: [], recentComplaints: [], expiringSubscriptions: [] } }) },
      globalSearch: { useQuery: () => ({ data: [] }) },
      listComplaints: { useQuery: () => ({ data: [{ id: 4, title: "شكوى اختبار", description: "تفاصيل الشكوى", priority: "high", status: "open", response: null, openedAt: new Date(), resolvedAt: null, tenantId: 1, tenantName: "مساحة مولد الاختبار", siteName: "محطة الاختبار", subscriberName: "مشترك تجريبي", assignedUserId: null, assignedUserName: null }] }) },
      updateComplaint: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      listTariffPolicies: { useQuery: () => ({ data: [] }) },
      createTariffPolicy: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      platformConfiguration: { useQuery: () => ({ data: { settings: [{ id: 11, settingKey: "invoice_delivery_channels", isEnabled: true, message: "", value: { whatsappEnabled: true, smsEnabled: true } }], recoveries: [], currentTariff: null } }) },
      listTenantFeatureEntitlements: { useQuery: () => ({ data: [] }) },
      setTenantFeatureEntitlement: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      savePlatformSetting: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      listTenantBranchSettings: { useQuery: () => ({ data: [] }) },
      saveTenantBranchSettings: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      requestOwnerAccessRecovery: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      generatorDetails: { useQuery: () => ({ data: { generator: { id: 22, name: "مولد اختبار", code: "GEN-T-01", status: "active", ratedCapacityKw: "100", operatingHours: "12", fuelLevelLiters: "50", tenantName: "مساحة مولد الاختبار", siteName: "خدمة الاختبار", lastMaintenanceAt: null }, activity: [] } }) },
      setTenantStatus: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      rolePolicies: { useQuery: () => ({ data: [] }) },
      saveRolePolicy: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      createGeneratorOwnerSubscription: { useMutation: () => ({ mutate: state.mutation, mutateAsync: state.mutation, isPending: false }) },
      createGeneratorOwnerWithTemporaryPassword: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      updateSubscription: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      resetUserPassword: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      renewSubscription: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      attachOwnerUser: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      setGeneratorStatus: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      approvePendingGenerator: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      recordSecurityEvent: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      saveSecuritySetting: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      createSmsPlan: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      updateSmsPlan: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      reviewSmsPackageRequest: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      saveTweetSmsAccount: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      testTweetSmsAccount: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      savePlatformTweetSmsAccount: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      testPlatformTweetSmsAccount: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
      savePlatformSmsFallbackProvider: { useMutation: () => ({ mutate: state.mutation, isPending: false }) },
    },
  },
}));

afterEach(() => { document.body.innerHTML = ""; state.role = "user"; state.collectionRate = 80; state.mutation.mockReset(); });

const sidebarNav = (label: string) => screen.getAllByRole("button", { name: label })[0];

describe("PowerHub platform administration UI", () => {
  it("hides the platform-wide console from a tenant user", () => {
    render(<AdminConsolePage />);
    expect(screen.getByText("هذه الصفحة مخصصة لآدمن PowerHub")).toBeInTheDocument();
    expect(screen.queryByText("أصحاب المولدات والاشتراكات")).not.toBeInTheDocument();
  });

  it("shows owner statistics and administration tabs to the platform admin", () => {
    state.role = "admin";
    render(<AdminConsolePage />);
    expect(screen.getByText("مركز قيادة المنصة")).toBeInTheDocument();
    expect(screen.getAllByText("إدارة المنصة").length).toBeGreaterThan(0);
    expect(screen.getByText("PLATFORM ADMIN")).toBeInTheDocument();
    expect(screen.getByText("إجمالي المشتركين")).toBeInTheDocument();
    expect(screen.getAllByText("150").length).toBeGreaterThan(0);
    fireEvent.click(sidebarNav("اشتراك صاحب مولد"));
    expect(screen.getByText("تسجيل اشتراك صاحب مولد")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("رقم الهوية")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("رقم WhatsApp (اختياري)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /إدارة التجديدات في المالية/ }));
    expect(screen.getByRole("button", { name: /تجديد الاشتراك/ })).toBeInTheDocument();
    fireEvent.click(sidebarNav("اشتراك صاحب مولد"));
    fireEvent.click(sidebarNav("إدارة المستخدمين"));
    expect(screen.getByText("محاسب الاختبار")).toBeInTheDocument();
    fireEvent.click(sidebarNav("المالية والتحصيل"));
    expect(screen.getByRole("button", { name: /تجديد الاشتراك/ })).toBeInTheDocument();
    fireEvent.click(sidebarNav("التقارير والإحصائيات"));
    expect(screen.getByRole("button", { name: /تصدير CSV/ })).toBeInTheDocument();
    fireEvent.click(sidebarNav("إرسال الفواتير"));
    expect(screen.getByText("إرسال فواتير المشتركين")).toBeInTheDocument();
    expect(screen.getAllByText("بانتظار بيانات المزود")).toHaveLength(1);
    expect(screen.getAllByText("حسابات TweetSMS").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "حفظ سياسة الإرسال" }));
    expect(state.mutation).toHaveBeenCalledWith(expect.objectContaining({ settingKey: "invoice_delivery_channels", isEnabled: true }));
    fireEvent.click(sidebarNav("رصيد وتقارير TweetSMS"));
    expect(screen.getByText("حساب TweetSMS المركزي للمنصة")).toBeInTheDocument();
    expect(screen.getByText("استهلاك الرسائل حسب صاحب المولد")).toBeInTheDocument();
    expect(screen.getByText("تنبيهات رصيد TweetSMS")).toBeInTheDocument();
    fireEvent.click(sidebarNav("حسابات TweetSMS"));
    expect(screen.getByText("حسابات TweetSMS لأصحاب المولدات")).toBeInTheDocument();
    expect(screen.getByText("مالك جديد")).toBeInTheDocument();
    expect(screen.getByText("بانتظار API")).toBeInTheDocument();
    expect(screen.getByText("تم التحقق من الربط")).toBeInTheDocument();
    expect(screen.getByText(/رصيد المزود:/)).toBeInTheDocument();
    const connectionButtons = screen.getAllByRole("button", { name: "فحص الاتصال وتأكيد الربط" });
    expect(connectionButtons).toHaveLength(2);
    expect(connectionButtons[0]).toBeEnabled();
    expect(connectionButtons[1]).toBeDisabled();
    const saveButtons = screen.getAllByRole("button", { name: "حفظ الحساب" });
    expect(saveButtons).toHaveLength(2);

    state.mutation.mockClear();
    fireEvent.click(connectionButtons[0]);
    expect(state.mutation).toHaveBeenCalledWith({ tenantId: 9 });

    const apiKeyInputs = screen.getAllByLabelText("API Key / Token");
    const senderInputs = screen.getAllByLabelText("اسم المرسل المسجّل في TweetSMS");
    fireEvent.change(apiKeyInputs[1], { target: { value: "new-tenant-api-key-123" } });
    fireEvent.change(senderInputs[1], { target: { value: "PowerHubNew" } });
    state.mutation.mockClear();
    fireEvent.click(saveButtons[1]);
    expect(state.mutation).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 10,
      apiKey: "new-tenant-api-key-123",
      senderName: "PowerHubNew",
      isActive: false,
    }));
    fireEvent.click(sidebarNav("إدارة المولدات"));
    expect(screen.getByText("مولدات محظورة")).toBeInTheDocument();
    fireEvent.click(sidebarNav("التنبيهات والإشعارات"));
    expect(screen.getByText("سجل الإشعارات")).toBeInTheDocument();
    fireEvent.click(sidebarNav("الأمان والسجلات"));
    expect(screen.getByText("أحداث الأمان والنسخ الاحتياطي")).toBeInTheDocument();
    fireEvent.click(sidebarNav("إعدادات المنصة"));
    expect(screen.getByText("وضع صيانة المنصة")).toBeInTheDocument();
  }, 15_000);

  it("يعرض صفراً لنسبة التحصيل عند وصول قيمة غير رقمية من قراءة التحليلات", () => {
    state.role = "admin";
    state.collectionRate = "NaN";
    render(<AdminConsolePage />);
    expect(screen.getAllByText("0%").length).toBeGreaterThan(0);
    expect(screen.queryByText((content) => content.includes("ليس") && content.includes("رقم"))).not.toBeInTheDocument();
  });

  it("keeps icon navigation available when the platform sidebar is collapsed", () => {
    state.role = "admin";
    render(<AdminConsolePage />);

    fireEvent.click(screen.getByRole("button", { name: "تصغير القائمة الجانبية" }));
    expect(screen.getByRole("button", { name: "توسيع القائمة الجانبية" })).toBeInTheDocument();
    fireEvent.click(sidebarNav("إدارة المولدات"));
    expect(screen.getByText("مولدات محظورة")).toBeInTheDocument();
  });

  it("renders central operational data and controlled states in every platform tab", () => {
    state.role = "admin";
    render(<AdminConsolePage />);
    fireEvent.click(sidebarNav("إدارة المولدات"));
    expect(screen.getAllByText("مولد اختبار").length).toBeGreaterThan(0);
    expect(screen.getByText("بانتظار المراجعة")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "حظر المولد" })).toBeInTheDocument();
    fireEvent.click(sidebarNav("إدارة المستخدمين"));
    expect(screen.getByText("محاسب الاختبار")).toBeInTheDocument();
    expect(screen.queryByText("مشترك تجريبي")).not.toBeInTheDocument();
    fireEvent.click(sidebarNav("المالية والتحصيل"));
    expect(screen.getByText("طرق الدفع الإلكتروني")).toBeInTheDocument();
    expect(screen.getAllByText("مولد اختبار").length).toBeGreaterThan(0);
    fireEvent.click(sidebarNav("الشكاوى"));
    expect(screen.getByText("شكوى اختبار")).toBeInTheDocument();
    fireEvent.click(sidebarNav("التنبيهات والإشعارات"));
    expect(screen.getByText("مساحة مولد الاختبار")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "الإرسال الجماعي مؤجل" })).toBeDisabled();
    fireEvent.click(sidebarNav("الأمان والسجلات"));
    expect(screen.getByText("نسخة اختبار")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تسجيل الحدث" })).toBeInTheDocument();
    fireEvent.click(sidebarNav("إعدادات المنصة"));
    expect(screen.getByText("استرداد وصول صاحب المولد")).toBeInTheDocument();
    expect(screen.getAllByText("إعدادات الصفحة العامة والميزات").length).toBeGreaterThan(0);
    expect(screen.getByText("الحسابات الفرعية لمالك المولد")).toBeInTheDocument();
    expect(screen.getByText("حد المشتركين حسب الاشتراك")).toBeInTheDocument();
    expect(screen.getByText("طلبات ترقية الباقات")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "موافقة" })).toBeInTheDocument();
    expect(screen.getByText("سياسات الصلاحيات الدقيقة")).toBeInTheDocument();
  });
});
