import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Download } from "lucide-react";
import { useState } from "react";

const labels: Record<string, string> = {
  cash: "كاش",
  jawwal_pay: "Jawwal Pay",
  palpay: "PalPay",
  bank_of_palestine: "بنك فلسطين",
  wallet: "محفظة",
  bank_transfer: "تحويل بنكي",
  card: "بطاقة",
};

const format = (value: number) => new Intl.NumberFormat("ar", { maximumFractionDigits: 2 }).format(value);

type MethodGroup = { method: string; count: number; amount: number };

export function summarizePaymentMethods(payments: any[], selectedMethod = "all") {
  const completed = payments.filter((row) => row.payment.status === "completed");
  const filtered = selectedMethod === "all" ? completed : completed.filter((row) => row.payment.paymentMethod === selectedMethod);
  const groups = Object.entries(filtered.reduce((acc: Record<string, Omit<MethodGroup, "method">>, row) => {
    const key = row.payment.paymentMethod;
    acc[key] ??= { count: 0, amount: 0 };
    acc[key].count += 1;
    acc[key].amount += Number(row.payment.amount);
    return acc;
  }, {})).map(([method, value]) => ({ method, ...value }));
  return { completed, filtered, groups, total: filtered.reduce((sum, row) => sum + Number(row.payment.amount), 0) };
}

function escapeCsv(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function buildPaymentMethodCsv(groups: MethodGroup[], total: number, selectedMethod: string) {
  const filterLabel = selectedMethod === "all" ? "كل طرق الدفع" : labels[selectedMethod] ?? selectedMethod;
  const lines = [
    ["تقرير ملخص التحصيلات حسب طريقة الدفع"],
    ["الفلتر", filterLabel],
    ["طريقة الدفع", "عدد الدفعات المكتملة", "إجمالي المبلغ"],
    ...groups.map((group) => [labels[group.method] ?? group.method, group.count, group.amount.toFixed(2)]),
    ["الإجمالي", "", total.toFixed(2)],
  ];
  return `\uFEFF${lines.map((line) => line.map(escapeCsv).join(",")).join("\r\n")}`;
}

function downloadPaymentMethodCsv(groups: MethodGroup[], total: number, selectedMethod: string) {
  const csv = buildPaymentMethodCsv(groups, total, selectedMethod);
  const fileLabel = selectedMethod === "all" ? "all-methods" : selectedMethod;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `powerhub-payment-method-summary-${fileLabel}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function PaymentMethodCollectionSummary({ payments }: { payments: any[] }) {
  const [method, setMethod] = useState("all");
  const { completed, groups, total } = summarizePaymentMethods(payments, method);
  const methods = Array.from(new Set(payments.filter((row) => row.payment.status === "completed").map((row) => row.payment.paymentMethod)));

  return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="font-bold text-white">ملخص التحصيل حسب طريقة الدفع</h2><p className="mt-1 text-sm text-slate-400">اعرض الدفعات المكتملة ضمن طريقة الدفع المطلوبة لتسهيل الجرد المالي.</p><p className="mt-3 font-display text-3xl font-extrabold text-emerald-300">{format(total)}</p></div><div className="flex flex-col gap-2 sm:items-end"><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">فلتر طريقة الدفع</span><select value={method} onChange={(event) => setMethod(event.target.value)} className="h-10 min-w-48 rounded-xl border border-white/10 bg-white/[.025] px-3 text-sm text-white outline-none focus:border-[#F5B800]/70"><option className="bg-[#111823]" value="all">كل الطرق</option>{methods.map((item) => <option className="bg-[#111823]" key={item} value={item}>{labels[item] ?? item}</option>)}</select></label><Button type="button" size="sm" variant="outline" disabled={!completed.length} onClick={() => downloadPaymentMethodCsv(groups, total, method)} className="border-[#F5B800]/40 text-[#F5B800] hover:bg-[#F5B800]/10 hover:text-[#ffd23f]"><Download className="ml-1 h-3.5 w-3.5" />تصدير CSV لـ Excel</Button></div></div><div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{groups.map((group) => <div key={group.method} className="rounded-xl border border-white/8 bg-white/[.025] p-4"><p className="text-xs font-bold text-slate-400">{labels[group.method] ?? group.method}</p><p className="mt-2 font-display text-xl font-extrabold text-[#F5B800]">{format(group.amount)}</p><p className="mt-1 text-xs text-slate-500">{group.count} دفعة مكتملة</p></div>)}{!groups.length ? <p className="text-sm text-slate-500">لا توجد دفعات مكتملة ضمن الفلتر المحدد.</p> : null}</div></CardContent></Card>;
}
