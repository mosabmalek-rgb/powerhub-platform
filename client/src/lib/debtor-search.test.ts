import { describe, expect, it } from "vitest";
import { filterDebtorsByQuery } from "./debtor-search";

describe("filterDebtorsByQuery", () => {
  const rows = [{ subscriber: "أحمد علي", invoiceNo: "INV-120" }, { subscriber: "سارة حسن", invoiceNo: "INV-121" }];

  it("يعثر على المتأخر باسم المشترك أو رقم الفاتورة دون حساسية حالة الأحرف", () => {
    expect(filterDebtorsByQuery(rows, "أحمد")).toEqual([rows[0]]);
    expect(filterDebtorsByQuery(rows, "inv-121")).toEqual([rows[1]]);
  });

  it("يعيد كامل النتائج عندما تكون عبارة البحث فارغة", () => {
    expect(filterDebtorsByQuery(rows, "   ")).toEqual(rows);
  });
});
