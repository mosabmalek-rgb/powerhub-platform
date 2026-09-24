import { describe, expect, it } from "vitest";
import { allowedOwnerSubaccountRoles, branchLimitForPlan, defaultBranchLimits, defaultOwnerSubaccountLimits, defaultOwnerSubscriberLimits, ownerSubaccountLimitForPlan, ownerSubaccountRoles, ownerSubscriberLimitForPlan, resolveBranchPolicy } from "./powerhub";

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
    expect(ownerSubaccountLimitForPlan("basic")).toBe(defaultOwnerSubaccountLimits.basic);
    expect(ownerSubaccountLimitForPlan("professional", { value: { limits: { professional: 8 } } })).toBe(8);
    expect(ownerSubaccountLimitForPlan("vip", { value: { limits: { vip: -1 } } })).toBe(defaultOwnerSubaccountLimits.vip);
  });

  it("تستخدم حصة المشتركين الافتراضية أو الحد المخصص لكل باقة", () => {
    expect(ownerSubscriberLimitForPlan("basic")).toBe(defaultOwnerSubscriberLimits.basic);
    expect(ownerSubscriberLimitForPlan("professional", { value: { limits: { professional: 750 } } })).toBe(750);
    expect(ownerSubscriberLimitForPlan("vip", { value: { limits: { vip: 100001 } } })).toBe(defaultOwnerSubscriberLimits.vip);
  });

  it("تطبّق حدود الأفرع الافتراضية أو السياسة التي يعتمدها آدمن المنصة", () => {
    expect(branchLimitForPlan("basic")).toBe(defaultBranchLimits.basic);
    expect(branchLimitForPlan("professional", { value: { defaultLimit: { professional: 6 } } })).toBe(6);
    expect(branchLimitForPlan("vip", { value: { defaultLimit: { vip: 0 } } })).toBe(defaultBranchLimits.vip);
  });

  it("تتطلب تفعيل المنصة لتمكين الأفرع، وتسمح للتجاوز اليدوي بتحديد الحد والسلوك", () => {
    const inherited = resolveBranchPolicy({ plan: "professional", platformSetting: { isEnabled: true, value: { defaultLimit: { professional: 3 } } }, currentCount: 1 });
    expect(inherited).toMatchObject({ isEnabled: true, maxBranches: 3, currentCount: 1, remaining: 2, disabledBehavior: "read_only" });

    const overridden = resolveBranchPolicy({ plan: "basic", platformSetting: { isEnabled: false, value: {} }, tenantSetting: { isEnabledOverride: true, maxBranchesOverride: 4, disabledBehavior: "suspended" }, currentCount: 4 });
    expect(overridden).toMatchObject({ isEnabled: true, maxBranches: 4, currentCount: 4, remaining: 0, disabledBehavior: "suspended" });

    const disabled = resolveBranchPolicy({ plan: "vip", platformSetting: { isEnabled: true, value: {} }, tenantSetting: { isEnabledOverride: false, maxBranchesOverride: null, disabledBehavior: "read_only" }, currentCount: 2 });
    expect(disabled.isEnabled).toBe(false);
  });
});
