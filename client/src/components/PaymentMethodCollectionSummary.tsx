import { Card, CardContent } from "@/components/ui/card";
import { useState } from "react";

const labels: Record<string, string> = { cash: "كاش", jawwal_pay: "Jawwal Pay", palpay: "PalPay", bank_of_palestine: "بنك فلسطين", wallet: "محفظة", bank_transfer: "تحويل بنكي", card: "بطاقة" };
const format = (value: number) => new Intl.NumberFormat("ar", { maximumFractionDigits: 2 }).format(value);

export function PaymentMethodCollectionSummary({ payments }: { payments: any[] }) {
  const [method, setMethod] = useState("all");
  const completed = payments.filter((row) => row.payment.status === "completed");
  const methods = Array.from(new Set(completed.map((row) => row.payment.paymentMethod)));
  const filtered = method === "all" ? completed : completed.filter((row) => row.payment.paymentMethod === method);
  const groups = Object.entries(filtered.reduce((acc: Record<string, { count: number; amount: number }>, row) => {
    const key = row.payment.paymentMethod;
    acc[key] ??= { count: 0, amount: 0 };
    acc[key].count += 1;
    acc[key].amount += Number(row.payment.amount);
    return acc;
  }, {}));
  const total = filtered.reduce((sum, row) => sum + Number(row.payment.amount), 0);

  return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="font-bold text-white">ملخص التحصيل حسب طريقة الدفع</h2><p className="mt-1 text-sm text-slate-400">اعرض الدفعات المكتملة ضمن طريقة الدفع المطلوبة لتسهيل الجرد المالي.</p><p className="mt-3 font-display text-3xl font-extrabold text-emerald-300">{format(total)}</p></div><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">فلتر طريقة الدفع</span><select value={method} onChange={(event) => setMethod(event.target.value)} className="h-10 min-w-48 rounded-xl border border-white/10 bg-white/[.025] px-3 text-sm text-white outline-none focus:border-[#F5B800]/70"><option className="bg-[#111823]" value="all">كل الطرق</option>{methods.map((item) => <option className="bg-[#111823]" key={item} value={item}>{labels[item] ?? item}</option>)}</select></label></div><div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{groups.map(([key, value]) => <div key={key} className="rounded-xl border border-white/8 bg-white/[.025] p-4"><p className="text-xs font-bold text-slate-400">{labels[key] ?? key}</p><p className="mt-2 font-display text-xl font-extrabold text-[#F5B800]">{format(value.amount)}</p><p className="mt-1 text-xs text-slate-500">{value.count} دفعة مكتملة</p></div>)}{!groups.length ? <p className="text-sm text-slate-500">لا توجد دفعات مكتملة ضمن الفلتر المحدد.</p> : null}</div></CardContent></Card>;
}
