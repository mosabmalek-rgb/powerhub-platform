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

  it("يقبل الرقم المرجعي الاختياري ويمنع تكراره أو إدخال صيغة غير آمنة", () => {
    const rows = prepareSubscriberImport([
      { subscriberNo: "sub-north-001", fullName: "أحمد العلي", phone: "+970599000001", address: "", subscriptionType: "سكني" },
      { subscriberNo: "SUB-NORTH-001", fullName: "محمد علي", phone: "+970599000002", address: "", subscriptionType: "تجاري" },
      { subscriberNo: "مرجع غير صالح", fullName: "خالد سالم", phone: "+970599000003", address: "", subscriptionType: "سكني" },
    ]);
    expect(rows[0]).toMatchObject({ subscriberNo: "SUB-NORTH-001", status: "error" });
    expect(rows[1].errors.join(" ")).toContain("الرقم المرجعي مكرر");
    expect(rows[2].errors.join(" ")).toContain("الرقم المرجعي يجب");
  });
  it("يحافظ على قراءات مختلفة لكل صف ويرفض السالب وغير الرقمي ويترك الفارغ اختيارياً", () => {
    const rows = prepareSubscriberImport([
      { fullName: "أحمد العلي", phone: "+970599000001", address: "", subscriptionType: "سكني", openingReading: "12" },
      { fullName: "محمد سالم", phone: "+970599000002", address: "", subscriptionType: "سكني", openingReading: "12.5" },
      { fullName: "خالد ناصر", phone: "+970599000003", address: "", subscriptionType: "تجاري", openingReading: "12.52" },
      { fullName: "سليم حسن", phone: "+970599000004", address: "", subscriptionType: "سكني", openingReading: "-1" },
      { fullName: "فادي عمر", phone: "+970599000005", address: "", subscriptionType: "تجاري", openingReading: "abc" },
      { fullName: "رامي صالح", phone: "+970599000006", address: "", subscriptionType: "سكني", openingReading: "" },
    ]);
    expect(rows.slice(0, 3).map((row) => row.openingReading)).toEqual(["12", "12.5", "12.52"]);
    expect(rows.slice(0, 3).every((row) => row.status === "ready")).toBe(true);
    expect(rows[3].status).toBe("error");
    expect(rows[4].status).toBe("error");
    expect(rows[5]).toMatchObject({ status: "ready", openingReading: "" });
  });

  it("يقبل القراءة الافتتاحية الصحيحة حتى منزلتين عشريتين ويرفض أكثر من منزلتين", () => {
    const make = (openingReading: string) => prepareSubscriberImport([{ fullName: "أحمد العلي", phone: "+970599000001", address: "", subscriptionType: "سكني", openingReading }])[0];
    expect(make("12")).toMatchObject({ status: "ready", openingReading: "12" });
    expect(make("12.5")).toMatchObject({ status: "ready", openingReading: "12.5" });
    expect(make("12.52")).toMatchObject({ status: "ready", openingReading: "12.52" });
    expect(make("12.523").errors.join(" ")).toContain("منزلتين عشريتين");
  });
});
