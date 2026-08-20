import DashboardLayout from "@/components/DashboardLayout";
import { MetricCard } from "@/components/MetricCard";
import { PowerHubLogo } from "@/components/PowerHubLogo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { authenticatedHomePath } from "@/lib/role-routing";
import { useLocation } from "wouter";
import {
  ArrowUpLeft, BellRing, Bolt, CalendarDays, ChevronLeft, CircleAlert,
  CircleDollarSign, FilePlus2, Gauge, PlugZap, ReceiptText,
  UsersRound, WalletCards, Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import MarketingLandingPage from "./MarketingLandingPage";

const quickActions = [
  { label: "إضافة مشترك", detail: "أنشئ ملف عميل وربطه بنقطة التوصيل", icon: UsersRound, path: "/subscribers" },
  { label: "تسجيل قراءة", detail: "أضف قراءة عداد وراجع الاستهلاك", icon: Gauge, path: "/readings" },
  { label: "إنشاء فاتورة", detail: "حول القراءة المعتمدة إلى فاتورة", icon: ReceiptText, path: "/invoices" },
  { label: "تسجيل تحصيل", detail: "سجل دفعة واطبع أو شارك الإيصال", icon: WalletCards, path: "/collections" },
];

export default function Home() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, loading, user } = useAuth();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated && !user?.mustChangePassword });
  const [siteId, setSiteId] = useState<number | null>(null);

  useEffect(() => {
    if (!siteId && sitesQuery.data?.[0]) setSiteId(sitesQuery.data[0].id);
  }, [siteId, sitesQuery.data]);

  useEffect(() => {
    if (!loading && isAuthenticated && user?.mustChangePassword) {
      setLocation("/profile");
      return;
    }
    if (!loading && isAuthenticated && user?.role === "admin") setLocation(authenticatedHomePath(user));
  }, [isAuthenticated, loading, setLocation, user]);

  const summaryQuery = trpc.powerhub.dashboard.summary.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && !user?.mustChangePassword) });
  const summary = summaryQuery.data;
  const formatNumber = (value: unknown, fractionDigits = 0) => new Intl.NumberFormat("ar", { maximumFractionDigits: fractionDigits }).format(Number(value ?? 0));
  const generatorStates = [
    { label: "المولدات العاملة", value: formatNumber(summary?.generators.active), hint: summary ? "تعمل ضمن المحطة المحددة" : "ستظهر بعد إضافة أول مولد", tone: "bg-emerald-400" },
    { label: "قيد الصيانة", value: formatNumber(summary?.generators.maintenance), hint: summary ? "تحتاج متابعة فنية" : "لا توجد أوامر صيانة مفتوحة", tone: "bg-sky-400" },
    { label: "متوقفة أو غير متصلة", value: "—", hint: summary ? "تُتابع من وحدة المولدات" : "لا توجد تنبيهات تشغيلية", tone: "bg-slate-500" },
  ];

  if (!isAuthenticated) return <MarketingLandingPage />;
  if (user?.mustChangePassword || user?.role === "admin") return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">جارٍ فتح المساحة المصرح بها…</h1></div></main>;

  return (
    <DashboardLayout>
      <div className="space-y-6 pb-12">
        <header className="flex flex-col gap-5 rounded-[24px] border border-white/8 bg-[#111823]/75 p-5 shadow-panel backdrop-blur sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex items-start gap-4">
            <div className="mt-0.5 lg:hidden"><PowerHubLogo compact /></div>
            <div>
              <div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Zap className="h-4 w-4 fill-current" />مركز التحكم</div>
              <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-white sm:text-3xl">صباح الخير، أهلاً بك في PowerHub</h1>
              <p className="mt-2 text-sm text-slate-400">تابع تشغيل الشبكة والتحصيلات وبيانات المشتركين من لوحة واحدة.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isAuthenticated && sitesQuery.data?.length ? <select aria-label="اختيار المحطة" value={siteId ?? ""} onChange={(event) => setSiteId(Number(event.target.value))} className="h-10 max-w-44 rounded-xl border border-white/10 bg-white/[0.02] px-3 text-sm font-bold text-slate-300 outline-none">{sitesQuery.data.map((site) => <option className="bg-[#111823]" value={site.id} key={site.id}>{site.name}</option>)}</select> : <Button variant="outline" className="border-white/10 bg-white/[0.02] text-slate-300 hover:bg-white/5 hover:text-white"><CalendarDays className="ml-2 h-4 w-4" />اليوم</Button>}
            <Button className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]" onClick={() => setLocation("/readings")}><FilePlus2 className="ml-2 h-4 w-4" />تسجيل قراءة</Button>
          </div>
        </header>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="الطاقة المفوترة" value={formatNumber(summary?.energyKwh, 3)} unit="kWh" description={summary ? "إجمالي الاستهلاك من الفواتير غير الملغاة." : "تظهر بعد اعتماد أول قراءة وفاتورة."} icon={Bolt} accent="gold" />
          <MetricCard label="إجمالي التحصيل" value={formatNumber(summary?.financial.collected, 2)} unit="—" description={summary ? "إجمالي الدفعات المرتبطة بالفواتير." : "لا توجد دفعات مسجلة للفترة المحددة."} icon={CircleDollarSign} accent="emerald" />
          <MetricCard label="المتأخرات" value={formatNumber(summary?.financial.outstanding, 2)} unit="—" description={summary ? "الرصيد المتبقي في الفواتير الصادرة." : "ستُحتسب من الفواتير المستحقة."} icon={CircleAlert} accent="rose" />
          <MetricCard label="المشتركون النشطون" value={formatNumber(summary?.subscribers)} unit="مشترك" description={summary ? "ملفات الخدمة النشطة للمحطة المحددة." : "ابدأ بإضافة ملفات المشتركين."} icon={UsersRound} accent="blue" />
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.55fr_0.85fr]">
          <Card className="border-white/8 bg-[#111823] shadow-panel">
            <CardContent className="p-0">
              <div className="flex flex-col gap-3 border-b border-white/8 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <div>
                  <h2 className="font-bold text-white">اتجاه الاستهلاك والتحصيل</h2>
                  <p className="mt-1 text-sm text-slate-400">قراءات العدادات والفواتير خلال الفترة المحددة.</p>
                </div>
                <Badge className="w-fit border-[#F5B800]/20 bg-[#F5B800]/10 text-[#F5B800] hover:bg-[#F5B800]/10">{summary ? "ملخص المحطة" : "بانتظار بيانات التشغيل"}</Badge>
              </div>
              <div className="relative flex min-h-[300px] flex-col items-center justify-center overflow-hidden px-6 text-center">
                <div className="absolute inset-x-6 bottom-8 top-10 opacity-50" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,.08) 1px, transparent 1px)", backgroundSize: "100% 52px" }} />
                <div className="relative z-10 grid h-16 w-16 place-items-center rounded-2xl border border-[#F5B800]/20 bg-[#F5B800]/10 text-[#F5B800]"><PlugZap className="h-7 w-7" /></div>
                <h3 className="relative z-10 mt-5 text-lg font-bold text-white">ابدأ من القراءة الأولى</h3>
                <p className="relative z-10 mt-2 max-w-sm text-sm leading-6 text-slate-400">سيظهر منحنى الاستهلاك والتحصيل تلقائياً بعد إضافة المولدات والعدادات واعتماد الفواتير.</p>
                <Button variant="link" className="relative z-10 mt-2 text-[#F5B800] hover:text-[#ffd23f]" onClick={() => setLocation("/readings")}>فتح إدارة القراءات <ChevronLeft className="mr-1 h-4 w-4" /></Button>
              </div>
            </CardContent>
          </Card>

          <Card className="border-white/8 bg-[#111823] shadow-panel">
            <CardContent className="p-0">
              <div className="flex items-center justify-between border-b border-white/8 px-5 py-5">
                <div>
                  <h2 className="font-bold text-white">حالة المولدات</h2>
                  <p className="mt-1 text-sm text-slate-400">ملخص تشغيلي مباشر للمحطات.</p>
                </div>
                <Bolt className="h-5 w-5 text-[#F5B800]" />
              </div>
              <div className="divide-y divide-white/8">
                {generatorStates.map((state) => (
                  <div key={state.label} className="flex items-center justify-between px-5 py-4">
                    <div className="flex items-center gap-3"><span className={`h-2.5 w-2.5 rounded-full ${state.tone}`} /><div><p className="text-sm font-bold text-white">{state.label}</p><p className="mt-1 text-xs text-slate-500">{state.hint}</p></div></div>
                    <span className="font-display text-2xl font-extrabold text-white">{state.value}</span>
                  </div>
                ))}
              </div>
              <button onClick={() => setLocation("/generators")} className="flex w-full items-center justify-between border-t border-white/8 px-5 py-4 text-sm font-bold text-[#F5B800] transition hover:bg-[#F5B800]/5">إدارة المحطات والمولدات <ArrowUpLeft className="h-4 w-4" /></button>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
          <Card className="border-white/8 bg-[#111823] shadow-panel">
            <CardContent className="p-5 sm:p-6">
              <div className="flex items-center justify-between"><div><h2 className="font-bold text-white">إجراءات سريعة</h2><p className="mt-1 text-sm text-slate-400">اختصارات لأهم عمليات اليوم.</p></div><Bolt className="h-5 w-5 text-[#F5B800]" /></div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {quickActions.map((action) => {
                  const Icon = action.icon;
                  return <button key={action.label} onClick={() => setLocation(action.path)} className="group flex items-start gap-3 rounded-xl border border-white/8 bg-white/[0.018] p-4 text-right transition hover:border-[#F5B800]/35 hover:bg-[#F5B800]/[0.045]">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#F5B800]/10 text-[#F5B800]"><Icon className="h-4 w-4" /></span>
                    <span><span className="block font-bold text-white">{action.label}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{action.detail}</span></span>
                  </button>;
                })}
              </div>
            </CardContent>
          </Card>

          <Card className="border-[#F5B800]/20 bg-gradient-to-br from-[#1b222c] to-[#111823] shadow-panel">
            <CardContent className="p-6">
              <div className="flex items-center justify-between"><div className="flex items-center gap-2 text-[#F5B800]"><BellRing className="h-4 w-4" /><span className="text-xs font-bold">تنبيهات المنصة</span></div><span className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] text-slate-400">{formatNumber(summary?.failedNotifications)} تنبيه</span></div>
              <h2 className="mt-6 text-xl font-extrabold text-white">{summary?.failedNotifications ? "توجد رسائل تحتاج متابعة" : "لا توجد تنبيهات حالياً"}</h2>
              <p className="mt-3 text-sm leading-7 text-slate-400">ستظهر هنا إشعارات المولدات، القراءات غير الطبيعية، المتأخرات، وحالات تسليم WhatsApp وSMS.</p>
              <button onClick={() => setLocation("/notifications")} className="mt-8 flex items-center gap-1 text-sm font-bold text-[#F5B800] hover:text-[#ffd23f]">عرض مركز الإشعارات <ChevronLeft className="h-4 w-4" /></button>
            </CardContent>
          </Card>
        </section>

        <section className="rounded-2xl border border-dashed border-white/10 bg-white/[0.015] px-5 py-4 text-sm text-slate-400 sm:flex sm:items-center sm:justify-between">
          <p><span className="font-bold text-white">تجهيز PowerHub:</span> أضف المحطة الأولى ثم المولدات والمشتركين لتبدأ لوحة المؤشرات بعرض بياناتك التشغيلية.</p>
          <Button variant="link" className="mt-1 px-0 text-[#F5B800] hover:text-[#ffd23f] sm:mt-0" onClick={() => setLocation("/settings")}>إعداد المشروع <ChevronLeft className="mr-1 h-4 w-4" /></Button>
        </section>
      </div>
    </DashboardLayout>
  );
}
