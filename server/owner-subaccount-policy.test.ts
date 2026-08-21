import { describe, expect, it } from "vitest";
import { allowedOwnerSubaccountRoles, ownerSubaccountRoles } from "./powerhub";

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
});
