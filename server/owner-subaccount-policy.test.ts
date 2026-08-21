import { describe, expect, it } from "vitest";
import { allowedOwnerSubaccountRoles, defaultOwnerSubaccountLimits, defaultOwnerSubscriberLimits, ownerSubaccountLimitForPlan, ownerSubaccountRoles, ownerSubscriberLimitForPlan } from "./powerhub";

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
    expect(ownerSubaccountLimitForPlan("starter")).toBe(defaultOwnerSubaccountLimits.starter);
    expect(ownerSubaccountLimitForPlan("professional", { value: { limits: { professional: 8 } } })).toBe(8);
    expect(ownerSubaccountLimitForPlan("enterprise", { value: { limits: { enterprise: -1 } } })).toBe(defaultOwnerSubaccountLimits.enterprise);
  });

  it("تستخدم حصة المشتركين الافتراضية أو الحد المخصص لكل باقة", () => {
    expect(ownerSubscriberLimitForPlan("starter")).toBe(defaultOwnerSubscriberLimits.starter);
    expect(ownerSubscriberLimitForPlan("professional", { value: { limits: { professional: 750 } } })).toBe(750);
    expect(ownerSubscriberLimitForPlan("enterprise", { value: { limits: { enterprise: 100001 } } })).toBe(defaultOwnerSubscriberLimits.enterprise);
  });
});
