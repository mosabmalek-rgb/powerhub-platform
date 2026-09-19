import { describe, expect, it } from "vitest";
import { allowedOwnerSubaccountRoles, branchLimitForPackage, branchLimitForPlan, defaultBranchLimits, defaultOwnerSubaccountLimits, defaultOwnerSubscriberLimits, ownerSubaccountLimitForPlan, ownerSubaccountRoles, ownerSubscriberLimitForPlan, resolveBranchPolicy } from "./powerhub";

describe("سياسة الحسابات الفرعية لمالك المولد", () => {
  it("تتيح أدوار الحسابات الفرعية القياسية عند عدم وجود إعداد مركزي", () => {
    expect(allowedOwnerSubaccountRoles()).toEqual(ownerSubaccountRoles);
  });

  it("تقتصر على الأدوار التي يعتمدها آدمن المنصة وتستبعد دور المالك دائماً", () => {
    expect(allowedOwnerSubaccountRoles({ isEnabled: true, value: { allowedRoles: ["accountant", "viewer", "owner", "unknown"] } })).toEqual(["accountant", "viewer"]);
  });

  it("تمنع إنشاء أو تعيين أي حساب فرعي عندما تعطل السياسة مركزياً", () => {
    expect(allowedOwnerSubaccountRoles({ isEnabled: false, value: { allowedRoles: ["manager"] } })).toEqual([]);
  });

  it("تستخدم حدود الباقات الافتراضية أو الأرقام المعتمدة من آدمن المنصة", () => {
    expect(ownerSubaccountLimitForPackage("basic")).toBe(defaultOwnerSubaccountLimits.basic);
    expect(ownerSubaccountLimitForPackage("professional", { value: { limits: { professional: 8 } } })).toBe(8);
    expect(ownerSubaccountLimitForPlan("enterprise", { value: { limits: { enterprise: -1 } } })).toBe(defaultOwnerSubaccountLimits.enterprise);
  });

  it("تستخدم حصة المشتركين الافتراضية أو الحد المخصص لكل باقة", () => {
    expect(ownerSubscriberLimitForPackage("basic")).toBe(defaultOwnerSubscriberLimits.basic);
    expect(ownerSubscriberLimitForPackage("professional", { value: { limits: { professional: 750 } } })).toBe(750);
    expect(ownerSubscriberLimitForPlan("enterprise", { value: { limits: { enterprise: 100001 } } })).toBe(defaultOwnerSubscriberLimits.enterprise);
  });

  it("تطبّق حدود الأفرع للباقات الخمس الجديدة ولا تعود إلى 3 أو 10", () => {
    expect(branchLimitForPackage("basic")).toBe(1);
    expect(branchLimitForPackage("advanced")).toBe(1);
    expect(branchLimitForPackage("professional")).toBe(1);
    expect(branchLimitForPackage("business")).toBe(1);
    expect(branchLimitForPackage("vip")).toBe(2);
    expect(branchLimitForPackage("vip", { value: { packageLimits: { vip: 4 } } })).toBe(4);
    expect(branchLimitForPlan("professional")).toBe(1);
    expect(branchLimitForPlan("enterprise")).toBe(1);
    expect(defaultBranchLimits.basic).toBe(1);
    expect(defaultBranchLimits.vip).toBe(2);
  });

  it("تتطلب تفعيل المنصة لتمكين الأفرع، وتسمح للتجاوز اليدوي بتحديد الحد والسلوك", () => {
    const inherited = resolveBranchPolicy({ plan: "professional", packageCode: "vip", platformSetting: { isEnabled: true, value: { packageLimits: { vip: 2 } } }, currentCount: 1 });
    expect(inherited).toMatchObject({ isEnabled: true, maxBranches: 2, currentCount: 1, remaining: 1, disabledBehavior: "read_only" });

    const overridden = resolveBranchPolicy({ plan: "starter", platformSetting: { isEnabled: false, value: {} }, tenantSetting: { isEnabledOverride: true, maxBranchesOverride: 4, disabledBehavior: "suspended" }, currentCount: 4 });
    expect(overridden).toMatchObject({ isEnabled: true, maxBranches: 4, currentCount: 4, remaining: 0, disabledBehavior: "suspended" });

    const disabled = resolveBranchPolicy({ plan: "enterprise", platformSetting: { isEnabled: true, value: {} }, tenantSetting: { isEnabledOverride: false, maxBranchesOverride: null, disabledBehavior: "read_only" }, currentCount: 2 });
    expect(disabled.isEnabled).toBe(false);
  });
});
