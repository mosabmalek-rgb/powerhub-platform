import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, BarChart3, CheckCircle2, Loader2, RefreshCw, Send, ShieldCheck } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { toast } from "sonner";

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";
const number = (value: unknown) => new Intl.NumberFormat("ar").format(Number(value ?? 0));
const dateTime = (value: Date | string | null | undefined) => value ? new Date(value).toLocaleString("ar-IQ", { dateStyle: "medium", timeStyle: "short" }) : "لم يُحدّث بعد";

export default function PlatformTweetSmsReport() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const reportInput = useMemo(() => ({ ...(from ? { from: new Date(`${from}T00:00:00`) } : {}), ...(to ? { to: new Date(`${to}T23:59:59`) } : {}) }), [from, to]);
  const utils = trpc.useUtils();
  const account = trpc.admin.getPlatformTweetSmsAccount.useQuery();
  const report = trpc.admin.platformTweetSmsReport.useQuery(reportInput);
  const refresh = async () => { await Promise.all([utils.admin.getPlatformTweetSmsAccount.invalidate(), utils.admin.platformTweetSmsReport.invalidate()]); };
  const save = trpc.admin.savePlatformTweetSmsAccount.useMutation({ onSuccess: async () => { await refresh(); toast.success("تم حفظ حساب TweetSMS المركزي بصورة مشفرة."); }, onError: (error) => toast.error(error.message) });
  const test = trpc.admin.testPlatformTweetSmsAccount.useMutation({ onSuccess: async (result) => { await refresh(); result.ok ? toast.success(result.message) : toast.error(result.message); }, onError: (error) => toast.error(error.message) });
  const rows = report.data?.usageRows ?? [];
  const maxUsage = Math.max(1, ...rows.map((row) => row.total));
  const configuration = account.data;

  return <section className="space-y-6" dir="rtl">
    <Card className="border-[#F5B800]/25 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 text-[#F5B800]" /><div><h2 className="font-bold text-white">حساب TweetSMS المركزي للمنصة</h2><p className="mt-1 max-w-3xl text-sm leading-7 text-slate-400">يربط هذا الحساب إرسال SMS لجميع أصحاب المولدات. يُحفظ مفتاح API مشفراً ولا يُعرض بعد الحفظ أو في واجهات المالكين.</p></div></div><p className="mt-4 rounded-xl border border-sky-400/20 bg-sky-400/[.06] p-3 text-xs leading-6 text-sky-200">يعرض النظام حالة <strong>مرسلة للمزود</strong> بعد نجاح TweetSMS فقط. لا يوسم الرسالة كمسلّمة ما لم يوفر المزود تقرير تسليم موثقاً.</p></CardContent></Card>

    <form className="grid gap-4 rounded-2xl border border-white/8 bg-[#111823] p-5 shadow-panel lg:grid-cols-2" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); save.mutate({ apiEndpoint: String(data.get("apiEndpoint")), apiKey: String(data.get("apiKey") || "") || undefined, apiSecret: String(data.get("apiSecret") || "") || undefined, senderName: String(data.get("senderName") || "") || undefined, lowBalanceThreshold: Number(data.get("lowBalanceThreshold")), isActive: data.get("isActive") === "on" }); }}>
      <div className="lg:col-span-2"><h3 className="font-bold text-white">بيانات الربط</h3><p className="mt-1 text-xs text-slate-500">استخدم الرابط الأساسي `https://tweetsms.ps` أو الرابط الرسمي الذي يخصصه TweetSMS لحساب المنصة.</p></div>
      <label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">رابط API</span><Input required name="apiEndpoint" type="url" defaultValue={configuration?.apiEndpoint ?? "https://tweetsms.ps"} dir="ltr" className={inputClass} /></label>
      <label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">اسم المرسل المسجل</span><Input name="senderName" defaultValue={configuration?.senderName ?? ""} placeholder="PowerHub" dir="ltr" className={inputClass} /></label>
      <label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">API Key</span><Input name="apiKey" type="password" minLength={8} autoComplete="new-password" placeholder={configuration?.configured ? "اتركه فارغاً للإبقاء على المفتاح الحالي" : "يُخزن مشفراً"} dir="ltr" className={inputClass} /></label>
      <label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">Token إضافي (اختياري)</span><Input name="apiSecret" type="password" autoComplete="new-password" placeholder="اختياري لفحص الرصيد" dir="ltr" className={inputClass} /></label>
      <label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">حد تنبيه الرصيد</span><Input required name="lowBalanceThreshold" type="number" min="0" defaultValue={configuration?.lowBalanceThreshold ?? 100} dir="ltr" className={inputClass} /></label>
      <div className="flex flex-wrap items-end gap-3"><label className="flex items-center gap-2 text-sm text-slate-300"><input name="isActive" type="checkbox" defaultChecked={configuration?.isActive} className="h-4 w-4 accent-[#F5B800]" />تفعيل الحساب المركزي</label><Button type="button" variant="outline" disabled={test.isPending || !configuration?.configured} onClick={() => test.mutate()} className="border-white/15 text-white hover:bg-white/5 hover:text-white">{test.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <RefreshCw className="ml-2 h-4 w-4" />}فحص الحساب والرصيد</Button><Button disabled={save.isPending} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">{save.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="ml-2 h-4 w-4" />}حفظ الحساب</Button></div>
    </form>

    <div className="grid gap-4 md:grid-cols-3"><Metric title="رصيد المزود" value={configuration?.lastProviderBalance === null || configuration?.lastProviderBalance === undefined ? "غير متاح" : number(configuration.lastProviderBalance)} note={dateTime(configuration?.lastBalanceCheckedAt)} tone="gold" /><Metric title="رسائل الفترة" value={number(report.data?.total)} note={from || to ? "وفق النطاق المختار" : "كل السجل المحلي"} tone="blue" /><Metric title="التنبيهات المفتوحة" value={number((report.data?.alerts ?? []).filter((alert) => alert.status === "open").length)} note="رصيد يساوي/أقل من حد التنبيه" tone="rose" /></div>

    <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><h3 className="font-bold text-white">استهلاك الرسائل حسب صاحب المولد</h3><p className="mt-1 text-xs text-slate-500">يحسب من سجل الإشعارات المحلي، ويمكن تحديد نطاق التاريخ.</p></div><div className="flex flex-wrap gap-2"><Input aria-label="من تاريخ" type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="h-9 w-36 rounded-xl border-white/10 bg-white/[.025] text-xs text-white" /><Input aria-label="إلى تاريخ" type="date" value={to} onChange={(event) => setTo(event.target.value)} className="h-9 w-36 rounded-xl border-white/10 bg-white/[.025] text-xs text-white" /><Button type="button" size="sm" variant="outline" onClick={() => { setFrom(""); setTo(""); }} className="border-white/10 text-white hover:bg-white/5 hover:text-white">مسح</Button></div></div><div className="mt-5 space-y-4">{rows.map((row) => <div key={row.tenantId} className="rounded-xl border border-white/7 bg-white/[.018] p-3"><div className="flex justify-between gap-3 text-sm"><span className="font-bold text-white">{row.tenantName}</span><span className="text-slate-400">{number(row.total)} رسالة · <span className="text-emerald-300">{number(row.submitted)} مرسلة</span> · <span className="text-rose-300">{number(row.failed)} فاشلة</span></span></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-[#F5B800]" style={{ width: `${Math.max(4, (row.total / maxUsage) * 100)}%` }} /></div></div>)}{!rows.length && <p className="py-8 text-center text-sm text-slate-500">لا توجد رسائل SMS ضمن الفترة المختارة.</p>}</div></CardContent></Card>

    <Card className="border-rose-400/15 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-rose-300" /><h3 className="font-bold text-white">تنبيهات رصيد TweetSMS</h3></div><div className="mt-4 space-y-3">{(report.data?.alerts ?? []).map((alert) => <div key={alert.id} className="flex flex-col justify-between gap-2 rounded-xl border border-white/8 bg-white/[.018] p-3 sm:flex-row sm:items-center"><div><p className="text-sm font-bold text-white">الرصيد {number(alert.balance)} مقابل حد {number(alert.threshold)}</p><p className="mt-1 text-xs text-slate-500">{dateTime(alert.notifiedAt)}</p></div><Badge className={alert.status === "open" ? "bg-rose-400/10 text-rose-300" : "bg-emerald-400/10 text-emerald-300"}>{alert.status === "open" ? "يتطلب متابعة" : "تمت المعالجة"}</Badge></div>)}{!(report.data?.alerts ?? []).length && <p className="py-6 text-center text-sm text-slate-500">لا توجد تنبيهات رصيد مسجلة.</p>}</div></CardContent></Card>
  </section>;
}

function Metric({ title, value, note, tone }: { title: string; value: string; note: string; tone: "gold" | "blue" | "rose" }) {
  const color = tone === "gold" ? "text-[#F5B800]" : tone === "blue" ? "text-sky-300" : "text-rose-300";
  return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-center justify-between"><p className="text-sm text-slate-400">{title}</p>{tone === "gold" ? <Send className={`h-4 w-4 ${color}`} /> : <BarChart3 className={`h-4 w-4 ${color}`} />}</div><p className={`mt-4 text-3xl font-extrabold ${color}`}>{value}</p><p className="mt-2 text-xs text-slate-500">{note}</p></CardContent></Card>;
}
