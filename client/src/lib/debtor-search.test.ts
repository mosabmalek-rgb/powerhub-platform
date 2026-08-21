import { describe, expect, it } from "vitest";
import { filterAndSortDebtors, filterDebtorsByQuery } from "./debtor-search";

describe("filterDebtorsByQuery", () => {
  const rows = [{ subscriber: "أحمد علي", invoiceNo: "INV-120" }, { subscriber: "سارة حسن", invoiceNo: "INV-121" }];

  it("يعثر على المتأخر باسم المشترك أو رقم الفاتورة دون حساسية حالة الأحرف", () => {
    expect(filterDebtorsByQuery(rows, "أحمد")).toEqual([rows[0]]);
    expect(filterDebtorsByQuery(rows, "inv-121")).toEqual([rows[1]]);
  });

  it("يعيد كامل النتائج عندما تكون عبارة البحث فارغة", () => {
    expect(filterDebtorsByQuery(rows, "   ")).toEqual(rows);
  });

  it("يصنّف المتأخرات ويرتبها حسب الرصيد أو عمر الدين", () => {
    const actionable = [
      { subscriber: "أحمد", invoiceNo: "INV-1", outstanding: 40, ageDays: 12, isOverdue: true, partialInvoices: 0 },
      { subscriber: "سارة", invoiceNo: "INV-2", outstanding: 90, ageDays: 5, isOverdue: true, partialInvoices: 1 },
      { subscriber: "ليان", invoiceNo: "INV-3", outstanding: 60, ageDays: 0, isOverdue: false, partialInvoices: 0 },
    ];
    expect(filterAndSortDebtors(actionable, "", "partial", "priority")).toEqual([actionable[1]]);
    expect(filterAndSortDebtors(actionable, "", "overdue", "age")).toEqual([actionable[0]]);
    expect(filterAndSortDebtors(actionable, "", "all", "balance").map((row) => row.invoiceNo)).toEqual(["INV-2", "INV-3", "INV-1"]);
  });
});
