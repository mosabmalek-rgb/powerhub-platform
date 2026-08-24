import { describe, expect, it } from "vitest";
import { prepareSubscriberImport } from "./subscriber-import";

describe("تحضير استيراد المشتركين", () => {
  it("يقبل الصيغ العربية لنوع الاشتراك ويحدد الصفوف السليمة", () => {
    const [row] = prepareSubscriberImport([{ fullName: "أحمد العلي", phone: "+970599000001", address: "غزة", subscriptionType: "سكني" }]);
    expect(row).toMatchObject({ status: "ready", normalizedSubscriptionType: "residential", rowNumber: 2 });
  });

  it("يكشف الرقم المكرر والبيانات غير المكتملة قبل الحفظ", () => {
    const rows = prepareSubscriberImport([
      { fullName: "أ", phone: "+970599000001", address: "", subscriptionType: "" },
      { fullName: "محمد علي", phone: "+970599000001", address: "", subscriptionType: "تجاري" },
    ]);
    expect(rows.every((row) => row.status === "error")).toBe(true);
    expect(rows[0].errors.join(" ")).toContain("مكرر");
  });
});
