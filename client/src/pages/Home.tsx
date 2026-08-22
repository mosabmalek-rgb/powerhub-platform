import DashboardLayout from "@/components/DashboardLayout";
import { MetricCard } from "@/components/MetricCard";
import { SubscriberQuotaDashboardCard } from "@/components/SubscriberQuotaDashboardCard";
import { PowerHubLogo } from "@/components/PowerHubLogo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/_core/hooks/useAuth";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { authenticatedHomePath } from "@/lib/role-routing";
import { useLocation } from "wouter";
import {
  ArrowUpLeft, BellRing, CalendarDays, ChevronLeft, CircleAlert,
  CircleDollarSign, Clock3, FilePlus2, FileText, ReceiptText,
  UsersRound, WalletCards, Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import MarketingLandingPage from "./MarketingLandingPage";

const quickActions = [
  { label: "إضافة مشترك", detail: "أنشئ ملف عميل جديد للخدمة", icon: UsersRound, path: "/subscribers" },
  { label: "إنشاء فاتورة", detail: "حوّل القراءة المعتمدة إلى فاتورة", icon: ReceiptText, path: "/invoices" },
  { label: "تسجيل تحصيل", detail: "سجل دفعة واطبع أو شارك الإيصال", icon: WalletCards, path: "/collections" },
  { label: "التقرير المالي", detail: "راجع تقرير اليوم أو الشهر وصدّره", icon: FileText, path: "/reports" },
];

const number = (value: unknown, fractionDigits = 0) => new Intl.NumberFormat("ar", { maximumFractionDigits: fractionDigits }).format(Number(value ?? 0));
const ratio = (value: unknown) => `${number(value, 1)}%`;

function StateLine({ label, value, hint, tone = "bg-[#F5B800]" }: { label: string; value: string; hint: string; tone?: string }) {
  return <div className="flex items-center justify-between gap-4 px-5 py-4"><div className="flex min-w-0 items-center gap-3"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${tone}`} /><div><p className="font-bold text-white">{label}</p><p className="mt-1 text-xs leading-5 text-slate-500">{hint}</p></div></div><span className="shrink-0 font-display text-xl font-extrabold text-white">{value}</span></div>;
}

export function WorkspaceHome() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, loading, user } = useAuth();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated && !user?.mustChangePassword });
  const { branchId: siteId, setBranchId: setSiteId } = useBranchFilter(sitesQuery.data);
  const [scope, setScope] = useState<"branch" | "all">("branch");
  const summaryQuery = trpc.powerhub.dashboard.summary.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && !user?.mustChangePassword) });
  const subscriberQuotaQuery = trpc.powerhub.subscribers.quota.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && !user?.mustChangePassword) });
  const accessQuery = trpc.powerhub.staff.myAccess.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && !user?.mustChangePassword) });
  const allBranchAccessQuery = trpc.powerhub.staff.allBranchAccess.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && !user?.mustChangePassword) });
  const upgradeRequestQuery = trpc.powerhub.subscription.currentUpgradeRequest.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && !user?.mustChangePassword) });
  const canUseAllBranches = Boolean(allBranchAccessQuery.data?.isGlobal && (sitesQuery.data?.length ?? 0) > 1);
  const selectedScope = scope === "all" && canUseAllBranches ? "all" : "branch";
  const financialOverviewQuery = trpc.powerhub.dashboard.financialOverview.useQuery({ siteId: siteId ?? 0, scope: selectedScope }, { enabled: Boolean(isAuthenticated && siteId && !user?.mustChangePassword) });
  const requestUpgrade = trpc.powerhub.subscription.requestUpgrade.useMutation({ onSuccess: (result) => { void upgradeRequestQuery.refetch(); toast.success(result.alreadyRequested ? "لديك طلب ترقية قيد المتابعة بالفعل." : `تم إرسال طلب الترقية إلى باقة ${result.requestedPlan}.`); }, onError: (error) => toast.error(error.message) });
  const overview = financialOverviewQuery.data;
  const activeSubscribers = overview?.branchSummaries.reduce((sum, branch) => sum + branch.activeSubscribers, 0) ?? 0;

  useEffect(() => {
    if (!loading && !isAuthenticated) { setLocation("/login"); return; }
    if (!loading && isAuthenticated && user?.mustChangePassword) { setLocation("/profile"); return; }
    if (!loading && isAuthenticated && user?.role === "admin") setLocation(authenticatedHomePath(user));
  }, [isAuthenticated, loading, setLocation, user]);

  useEffect(() => { if (scope === "all" && !canUseAllBranches) setScope("branch"); }, [canUseAllBranches, scope]);

  if (!isAuthenticated) return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">جارٍ توجيهك إلى تسجيل الدخول…</h1></div></main>;
  if (user?.mustChangePassword || user?.role === "admin") return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">جارٍ فتح المساحة المصرح بها…</h1></div></main>;

  return <DashboardLayout><div className="space-y-6 pb-12">
    <header className="flex flex-col gap-5 rounded-[24px] border border-white/8 bg-[#111823]/75 p-5 shadow-panel backdrop-blur sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div className="flex items-start gap-4"><div className="mt-0.5 lg:hidden"><PowerHubLogo compact /></div><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Zap className="h-4 w-4 fill-current" />مركز الأداء المالي</div><h1 className="mt-1 text-2xl font-extrabold tracking-tight text-white sm:text-3xl">الفوترة والتحصيل تحت السيطرة</h1><p className="mt-2 text-sm text-slate-400">تابع المستحقات والتحصيل والمتأخرات وحالة الفروع من شاشة واحدة.</p></div></div>
      <div className="flex flex-wrap items-center gap-2">{isAuthenticated && sitesQuery.data?.length ? <select aria-label="اختيار الفرع أو الملخص المجمع" value={selectedScope === "all" ? "all" : String(siteId ?? "")} onChange={(event) => { const value = event.target.value; if (value === "all") setScope("all"); else { setScope("branch"); setSiteId(Number(value)); } }} className="h-10 max-w-56 rounded-xl border border-white/10 bg-white/[0.02] px-3 text-sm font-bold text-slate-300 outline-none">{canUseAllBranches && <option className="bg-[#111823]" value="all">جميع الأفرع (ملخص مجمّع)</option>}{sitesQuery.data.map((site) => <option className="bg-[#111823]" value={site.id} key={site.id}>{site.name}</option>)}</select> : <Button variant="outline" className="border-white/10 bg-white/[0.02] text-slate-300 hover:bg-white/5 hover:text-white"><CalendarDays className="ml-2 h-4 w-4" />اليوم</Button>}<Button className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]" onClick={() => setLocation("/collections")}><WalletCards className="ml-2 h-4 w-4" />تسجيل تحصيل</Button></div>
    </header>

    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      <MetricCard label="فوترة الشهر" value={number(overview?.month.invoiced, 2)} unit="—" description={`الفواتير الصادرة خلال ${overview?.period.month ?? "هذا الشهر"}.`} icon={ReceiptText} accent="gold" />
      <MetricCard label="تحصيل الشهر" value={number(overview?.month.collected, 2)} unit="—" description="الدفعات المكتملة خلال الشهر الحالي." icon={CircleDollarSign} accent="emerald" />
      <MetricCard label="نسبة التحصيل" value={ratio(overview?.month.collectionRate)} unit="" description="التحصيل مقارنة بفوترة الشهر." icon={ArrowUpLeft} accent="blue" />
      <MetricCard label="المتأخرات" value={number(overview?.outstanding.total, 2)} unit="—" description={`${number(overview?.outstanding.accountCount)} حساباً برصيد مفتوح.`} icon={CircleAlert} accent="rose" />
      <MetricCard label="المشتركون النشطون" value={number(activeSubscribers)} unit="مشترك" description={selectedScope === "all" ? `عبر ${overview?.branchSummaries.length ?? 0} أفرع.` : "ضمن الفرع المحدد."} icon={UsersRound} accent="blue" />
    </section>

    <SubscriberQuotaDashboardCard quota={subscriberQuotaQuery.data} upgradeRequest={upgradeRequestQuery.data} canRequestUpgrade={accessQuery.data?.role === "owner"} requesting={requestUpgrade.isPending} onRequestUpgrade={(requestedPlan) => requestUpgrade.mutate({ siteId: siteId!, requestedPlan })} />

    <section className="grid gap-6 xl:grid-cols-[1.35fr_.85fr]">
      <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="flex flex-col gap-3 border-b border-white/8 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6"><div><h2 className="font-bold text-white">نبض التحصيل</h2><p className="mt-1 text-sm text-slate-400">قراءة سريعة لنتيجة اليوم ووضع الشهر المالي.</p></div><Badge className="w-fit border-[#F5B800]/20 bg-[#F5B800]/10 text-[#F5B800] hover:bg-[#F5B800]/10">{selectedScope === "all" ? "جميع الأفرع" : "الفرع المحدد"}</Badge></div><div className="grid gap-4 p-5 sm:grid-cols-2"><div className="rounded-2xl border border-sky-400/15 bg-sky-400/[.045] p-5"><div className="flex items-center gap-2 text-sm font-bold text-sky-200"><CalendarDays className="h-4 w-4" />نتيجة اليوم</div><p className="mt-5 font-display text-3xl font-extrabold text-white">{number(overview?.today.collected, 2)}</p><p className="mt-1 text-xs text-slate-400">تحصيل اليوم من فوترة {number(overview?.today.invoiced, 2)}</p><div className="mt-5 h-2 overflow-hidden rounded-full bg-sky-950/80"><div className="h-full rounded-full bg-sky-400 transition-[width] duration-300" style={{ width: `${Math.min(100, Number(overview?.today.collectionRate ?? 0))}%` }} /></div><p className="mt-2 text-xs font-bold text-sky-200">نسبة تحصيل اليوم: {ratio(overview?.today.collectionRate)}</p></div><div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[.045] p-5"><div className="flex items-center gap-2 text-sm font-bold text-emerald-200"><CircleDollarSign className="h-4 w-4" />صافي النقد الشهري</div><p className="mt-5 font-display text-3xl font-extrabold text-white">{number(overview?.month.netCash, 2)}</p><p className="mt-1 text-xs text-slate-400">التحصيل {number(overview?.month.collected, 2)} − المصروفات {number(overview?.month.expenses, 2)}</p><div className="mt-5 flex items-center justify-between rounded-xl border border-white/8 bg-[#0D1117]/35 px-3 py-2 text-xs"><span className="text-slate-400">نسبة تحصيل الشهر</span><strong className="text-emerald-300">{ratio(overview?.month.collectionRate)}</strong></div></div></div></CardContent></Card>
      <Card className="border-rose-400/20 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="flex items-center justify-between border-b border-white/8 px-5 py-5"><div><h2 className="font-bold text-white">تحتاج متابعة الآن</h2><p className="mt-1 text-sm text-slate-400">أولوية التحصيل والذمم المفتوحة.</p></div><Clock3 className="h-5 w-5 text-rose-300" /></div><div className="divide-y divide-white/8"><StateLine label="رصيد متأخر" value={number(overview?.outstanding.overdue, 2)} hint="فواتير تجاوزت تاريخ الاستحقاق." tone="bg-rose-400" /><StateLine label="دفعات جزئية" value={number(overview?.outstanding.partialInvoices)} hint="فواتير تحتاج متابعة الرصيد المتبقي." tone="bg-amber-400" /><StateLine label="حسابات مفتوحة" value={number(overview?.outstanding.accountCount)} hint="مشتركون لديهم رصيد قائم." tone="bg-sky-400" /></div><button onClick={() => setLocation("/collections")} className="flex w-full items-center justify-between border-t border-white/8 px-5 py-4 text-sm font-bold text-[#F5B800] transition hover:bg-[#F5B800]/5">فتح قائمة التحصيل ذات الأولوية <ChevronLeft className="h-4 w-4" /></button></CardContent></Card>
    </section>

    <section className="grid gap-6 xl:grid-cols-[1.15fr_.85fr]">
      <DebtorsCard rows={overview?.topDebtors ?? []} allBranches={selectedScope === "all"} onOpenCollections={() => setLocation("/collections")} />
      <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-6"><div className="flex items-center justify-between"><div className="flex items-center gap-2 text-[#F5B800]"><BellRing className="h-4 w-4" /><span className="text-xs font-bold">حالة المتابعة</span></div><span className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] text-slate-400">{number(summaryQuery.data?.failedNotifications)} رسالة فاشلة</span></div><h2 className="mt-6 text-xl font-extrabold text-white">متابعة التحصيل من مصدر واحد</h2><p className="mt-3 text-sm leading-7 text-slate-400">افتح الفواتير لمراجعة حالة السداد، أو سجل دفعة مباشرة، أو راجع التقرير المالي التفصيلي بحسب الفرع.</p><div className="mt-6 grid gap-2 sm:grid-cols-2"><Button onClick={() => setLocation("/invoices")} variant="outline" className="border-white/10 text-white hover:bg-white/5 hover:text-white">مراجعة الفواتير</Button><Button onClick={() => setLocation("/reports")} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">فتح التقرير المالي</Button></div></CardContent></Card>
    </section>

    {selectedScope === "all" && <BranchPerformanceCard rows={overview?.branchSummaries ?? []} onOpenReports={() => setLocation("/reports")} />}

    <section className="grid gap-6 xl:grid-cols-[1.15fr_.85fr]"><Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5 sm:p-6"><div className="flex items-center justify-between"><div><h2 className="font-bold text-white">إجراءات مالية سريعة</h2><p className="mt-1 text-sm text-slate-400">اختصارات لدورة الفوترة والتحصيل اليومية.</p></div><Zap className="h-5 w-5 text-[#F5B800]" /></div><div className="mt-5 grid gap-3 sm:grid-cols-2">{quickActions.map((action) => { const Icon = action.icon; return <button key={action.label} onClick={() => setLocation(action.path)} className="group flex items-start gap-3 rounded-xl border border-white/8 bg-white/[0.018] p-4 text-right transition hover:border-[#F5B800]/35 hover:bg-[#F5B800]/[0.045]"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#F5B800]/10 text-[#F5B800]"><Icon className="h-4 w-4" /></span><span><span className="block font-bold text-white">{action.label}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{action.detail}</span></span></button>; })}</div></CardContent></Card><Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-6"><h2 className="font-bold text-white">نطاق العمل المالي</h2><p className="mt-3 text-sm leading-7 text-slate-400">المشتركون والفواتير والتحصيلات تتبع الفرع أو الخدمة. تظهر المولدات فقط في قسم التشغيل عند الحاجة إلى متابعة الوقود أو الصيانة، ولا تؤثر في مؤشرات التحصيل الأساسية.</p><button onClick={() => setLocation("/reports")} className="mt-6 flex items-center gap-1 text-sm font-bold text-[#F5B800] hover:text-[#ffd23f]">التقرير اليومي والشهري <ChevronLeft className="h-4 w-4" /></button></CardContent></Card></section>
  </div></DashboardLayout>;
}

function DebtorsCard({ rows, allBranches, onOpenCollections }: { rows: Array<{ subscriber: string; subscriberNo: string; branchName: string; outstanding: number; ageDays: number; partialInvoices: number; isOverdue: boolean }>; allBranches: boolean; onOpenCollections: () => void }) {
  return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="flex items-center justify-between border-b border-white/8 px-5 py-5"><div><h2 className="font-bold text-white">أولوية المتأخرات</h2><p className="mt-1 text-sm text-slate-400">مرتبة حسب تجاوز الاستحقاق ثم الرصيد المتبقي.</p></div><CircleAlert className="h-5 w-5 text-rose-300" /></div><div className="overflow-x-auto p-5">{rows.length ? <table className="w-full min-w-[590px] text-sm"><thead className="text-right text-xs text-slate-500"><tr>{allBranches && <th className="pb-3">الفرع</th>}<th className="pb-3">المشترك</th><th className="pb-3">الرصيد</th><th className="pb-3">عمر الدين</th><th className="pb-3">الحالة</th></tr></thead><tbody>{rows.map((row) => <tr className="border-t border-white/7" key={`${row.branchName}-${row.subscriberNo}`} >{allBranches && <td className="py-3 text-slate-400">{row.branchName}</td>}<td className="py-3"><p className="font-bold text-white">{row.subscriber}</p><p className="mt-1 font-display text-[11px] text-[#F5B800]" dir="ltr">{row.subscriberNo}</p></td><td className="py-3 font-bold text-rose-200">{number(row.outstanding, 2)}</td><td className="py-3 text-slate-300">{row.isOverdue ? `${number(row.ageDays)} يوم` : "غير مستحق بعد"}</td><td className="py-3"><Badge className={row.isOverdue ? "border-rose-400/20 bg-rose-400/10 text-rose-300" : "border-amber-400/20 bg-amber-400/10 text-amber-200"}>{row.partialInvoices ? "دفعة جزئية" : row.isOverdue ? "متأخر" : "مستحق قريباً"}</Badge></td></tr>)}</tbody></table> : <div className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-slate-500">لا توجد أرصدة مفتوحة ضمن النطاق الحالي.</div>}</div><button onClick={onOpenCollections} className="flex w-full items-center justify-between border-t border-white/8 px-5 py-4 text-sm font-bold text-[#F5B800] transition hover:bg-[#F5B800]/5">إدارة التحصيلات والفواتير <ChevronLeft className="h-4 w-4" /></button></CardContent></Card>;
}

function BranchPerformanceCard({ rows, onOpenReports }: { rows: Array<{ id: number; name: string; activeSubscribers: number; invoiced: number; collected: number; outstanding: number; collectionRate: number }>; onOpenReports: () => void }) {
  return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="flex items-center justify-between border-b border-white/8 px-5 py-5"><div><h2 className="font-bold text-white">الأداء المالي حسب الفرع</h2><p className="mt-1 text-sm text-slate-400">مقارنة شهرية لتحديد الفروع التي تحتاج تدخلاً.</p></div><Button variant="outline" onClick={onOpenReports} className="border-white/10 text-white hover:bg-white/5 hover:text-white">التقرير التفصيلي</Button></div><div className="overflow-x-auto p-5">{rows.length ? <table className="w-full min-w-[720px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-3">الفرع</th><th className="pb-3">المشتركون</th><th className="pb-3">الفوترة</th><th className="pb-3">التحصيل</th><th className="pb-3">نسبة التحصيل</th><th className="pb-3">المتأخرات</th></tr></thead><tbody>{rows.map((row) => <tr className="border-t border-white/7" key={row.id}><td className="py-3 font-bold text-white">{row.name}</td><td className="py-3 text-slate-300">{number(row.activeSubscribers)}</td><td className="py-3 text-slate-300">{number(row.invoiced, 2)}</td><td className="py-3 text-emerald-300">{number(row.collected, 2)}</td><td className="py-3"><span className={row.collectionRate < 70 ? "font-bold text-rose-300" : "font-bold text-emerald-300"}>{ratio(row.collectionRate)}</span></td><td className="py-3 font-bold text-rose-200">{number(row.outstanding, 2)}</td></tr>)}</tbody></table> : <p className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-slate-500">لا توجد فروع نشطة لعرض المقارنة.</p>}</div></CardContent></Card>;
}

export default function Home() { return <MarketingLandingPage />; }
