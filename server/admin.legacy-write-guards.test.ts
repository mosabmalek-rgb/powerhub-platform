import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }) }));

vi.mock("./db", () => ({ getDb: state.getDb, syncSupabaseUser: vi.fn() }));
vi.mock("./supabase-admin", () => ({ supabaseAdmin: vi.fn(() => { throw new Error("Supabase must not be called by a guarded legacy write"); }) }));

import { adminRouter } from "./admin";

const adminCaller = adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_admin" } as never, req: {} as never, res: {} as never });
const ownerCaller = adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_owner" } as never, req: {} as never, res: {} as never });

describe("حراس الكتابات الإدارية الموروثة", () => {
  it("يوقف كل كتابة إدارية موروثة قبل أي وصول MySQL أو Supabase", async () => {
    const guardedWrites: Array<Promise<unknown>> = [
      adminCaller.quickUpgradeOwnerPlan({ tenantId: 1, plan: "professional" }),
      ownerCaller.invitePlatformAccess({ email: "finance@example.test", platformRole: "finance_admin" }),
      ownerCaller.setPlatformAccountStatus({ userId: 2, accountStatus: "locked" }),
      ownerCaller.setPlatformAccessRole({ userId: 2, platformRole: "finance_admin" }),
      adminCaller.inviteTenantAccess({ tenantId: 1, siteId: 1, email: "staff@example.test", tenantRole: "member", siteRole: "accountant" }),
      adminCaller.createGeneratorOwner({ tenantName: "مولدات الاختبار", slug: "test-generator", ownerName: "مالك الاختبار", ownerPhone: "0590000000", siteName: "الفرع الرئيسي", siteCode: "HQ", generatorName: "مولد الاختبار", generatorCode: "GEN-1", generatorCapacityKw: 100 }),
      adminCaller.createSmsPlan({ code: "starter_sms", name: "باقة اختبار", includedMessages: 100, isActive: true }),
      adminCaller.updateSmsPlan({ id: 1, isActive: false }),
      adminCaller.reviewSmsPackageRequest({ id: 1, status: "approved", approvedMessages: 100 }),
      adminCaller.renewSubscription({ tenantId: 1, periods: 1 }),
      adminCaller.updateComplaint({ id: 1, status: "resolved", response: "تمت المعالجة" }),
      adminCaller.createTariffPolicy({ minimumPricePerKwh: 0.2, maximumPricePerKwh: 0.8, effectiveFrom: new Date("2026-09-01T00:00:00.000Z") }),
      adminCaller.saveTenantBranchSettings({ tenantId: 1, isEnabledOverride: true, maxBranchesOverride: 3, disabledBehavior: "read_only" }),
      adminCaller.savePlatformSetting({ settingKey: "maintenance_mode", isEnabled: false }),
      adminCaller.requestOwnerAccessRecovery({ tenantId: 1 }),
      adminCaller.saveRolePolicy({ role: "accountant", capability: "managePayroll", isAllowed: true }),
    ];
    for (const operation of guardedWrites) await expect(operation).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(state.getDb).not.toHaveBeenCalled();
  });
});
