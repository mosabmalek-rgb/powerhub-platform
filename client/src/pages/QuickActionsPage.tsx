import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/_core/hooks/useAuth";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, BellRing, BookOpenCheck, CircleDollarSign, FileText, Gauge, PackagePlus, ReceiptText, TrendingUp, UserPlus, UsersRound, WalletCards, Zap } from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";

type Capability = "manageSubscribers" | "recordReadings" | "issueInvoices" | "collectPayments" | "manageExpenses" | "manageMessaging";

const primaryActions: Array<{ label: string; description: string; path: string; capability: Capability; icon: typeof UserPlus; tone: string; group: string }> = [
  { label: "إضافة مشترك", description: "إنشاء ملف خدمة جديد وربطه بالفرع الحالي.", path: "/subscribers", capability: "manageSubscribers", icon: UserPlus, tone: "gold", group: "إدارة الخدمة" },
  { label: "تسجيل قراءة", description: "إدخال قراءة عداد والتحقق قبل الفوترة.", path: "/readings", capability: "recordReadings", icon: Gauge, tone: "sky", group: "دورة الفوترة" },
  { label: "إنشاء فاتورة", description: "إصدار فاتورة من قراءة معتمدة أو مراجعة مسودة.", path: "/invoices", capability: "issueInvoices", icon: ReceiptText, tone: "violet", group: "دورة الفوترة" },
  { label: "تحصيل دين", description: "تسجيل دفعة كاملة أو جزئية وإصدار إيصال.", path: "/collections", capability: "collectPayments", icon: WalletCards, tone: "emerald", group: "التحصيل" },
  { label: "تسجيل مصروف", description: "إضافة وقود أو صيانة أو مصروف تشغيلي للفرع.", path: "/expenses", capability: "manageExpenses", icon: CircleDollarSign, tone: "rose", group: "المالية" },
  { label: "إرسال إشعارات", description: "مراجعة إشعارات الفواتير وحالة رسائل SMS.", path: "/notifications", capability: "manageMessaging", icon: BellRing, tone: "amber", group: "التواصل" },
];

const supportActions = [
  { label: "الفواتير والتعرفات", description: "مراجعة الفواتير والأسعار والذمم.", path: "/invoices", icon: FileText },
  { label: "حسابات الشركة", description: "الأرصدة والحركات والتحويلات.", path: "/company-accounts", icon: BookOpenCheck },
  { label: "التقرير المالي", description: "تحليل التحصيل والمصروفات والتصدير.", path: "/reports", icon: TrendingUp },
  { label: "الحسابات الفرعية", description: "إدارة الموظفين وصلاحياتهم.", path: "/staff", icon: UsersRound },
];

const toneClasses: Record<string, { icon: string; border: string; hover: string; label: string }> = {
  gold: { icon: "bg-[#F5B800]/15 text-[#F5B800]", border: "border-[#F5B800]/25", hover: "hover:border-[#F5B800]/70 hover:bg-[#F5B800]/[.055]", label: "text-[#F5B800]" },
  sky: { icon: "bg-sky-400/10 text-sky-300", border: "border-sky-400/20", hover: "hover:border-sky-400/60 hover:bg-sky-400/[.05]", label: "text-sky-300" },
  violet: { icon: "bg-violet-400/10 text-violet-300", border: "border-violet-400/20", hover: "hover:border-violet-400/60 hover:bg-violet-400/[.05]", label: "text-violet-300" },
  emerald: { icon: "bg-emerald-400/10 text-emerald-300", border: "border-emerald-400/20", hover: "hover:border-emerald-400/60 hover:bg-emerald-400/[.05]", label: "text-emerald-300" },
  rose: { icon: "bg-rose-400/10 text-rose-300", border: "border-rose-400/20", hover: "hover:border-rose-400/60 hover:bg-rose-400/[.05]", label: "text-rose-300" },
  amber: { icon: "bg-amber-300/10 text-amber-200", border: "border-amber-300/20", hover: "hover:border-amber-300/60 hover:bg-amber-300/[.05]", label: "text-amber-200" },
};

export default function QuickActionsPage() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: Boolean(user && user.role !== "admin") });
  const { branchId: siteId, setBranchId: setSiteId } = useBranchFilter(sitesQuery.data);
  const accessQuery = trpc.powerhub.staff.myAccess.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId && user && user.role !== "admin") });
  const permissions = new Set(accessQuery.data?.permissions ?? []);
  const canUse = (capability: Capability) => accessQuery.data?.role === "owner" || permissions.has(capability);
  const visiblePrimaryActions = primaryActions.filter((action) => canUse(action.capability));
  const selectedSite = sitesQuery.data?.find((site) => site.id === siteId);

  return <DashboardLayout><main className="space-y-6 pb-12" dir="rtl"><header className="overflow-hidden rounded-[26px] border border-[#F5B800]/20 bg-[#111823] shadow-panel"><div className="relative p-6 sm:p-7"><div className="absolute -left-16 -top-20 h-52 w-52 rounded-full bg-[#F5B800]/[.08] blur-3xl" /><div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Zap className="h-4 w-4 fill-current" />مساحة عمل يومية</div><h1 className="mt-2 text-2xl font-extrabold tracking-tight text-white sm:text-3xl">الإجراءات السريعة</h1><p className="mt-2 max-w-2xl text-sm leading-7 text-slate-400">ابدأ عمليات الفوترة والتحصيل والتشغيل من شاشة واحدة. تظهر لك الإجراءات المسموح بها وفق صلاحياتك فقط.</p></div><div className="flex flex-wrap items-center gap-2"><Badge className="border-[#F5B800]/20 bg-[#F5B800]/10 text-[#F5B800]">{accessQuery.data?.role === "owner" ? "مالك المولد" : accessQuery.data?.role === "manager" ? "مدير تشغيل" : accessQuery.data?.role === "accountant" ? "محاسب" : accessQuery.data?.role === "collector" ? "محصل" : accessQuery.data?.role === "technician" ? "فني" : "حسب الصلاحية"}</Badge>{sitesQuery.data?.length ? <select aria-label="اختيار الفرع للإجراءات السريعة" value={String(siteId ?? "")} onChange={(event) => setSiteId(Number(event.target.value))} className="h-10 max-w-56 rounded-xl border border-white/10 bg-[#0D1117]/80 px-3 text-sm font-bold text-slate-200 outline-none focus:border-[#F5B800]/70">{sitesQuery.data.map((site) => <option className="bg-[#111823]" value={site.id} key={site.id}>{site.name}</option>)}</select> : null}</div></div></div><div className="relative border-t border-white/8 bg-black/10 px-6 py-3 text-xs text-slate-500">النطاق الحالي: <strong className="font-bold text-slate-300">{selectedSite?.name ?? "جارٍ تحديد الفرع"}</strong> — كل عملية تفتح ضمن هذا السياق المحمي.</div></header>

    {accessQuery.isLoading || sitesQuery.isLoading ? <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <Card key={index} className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="h-44 animate-pulse p-5"><div className="h-11 w-11 rounded-xl bg-white/10" /><div className="mt-5 h-4 w-32 rounded bg-white/10" /><div className="mt-3 h-3 w-full rounded bg-white/5" /></CardContent></Card>)}</section> : !siteId ? <Card className="border-amber-300/25 bg-amber-300/[.05] shadow-panel"><CardContent className="p-6 text-center"><h2 className="font-bold text-amber-100">لا يوجد فرع تشغيلي محدد</h2><p className="mt-2 text-sm text-slate-400">أضف فرعاً أو اطلب الوصول إلى فرع قبل بدء العمليات اليومية.</p><Button className="mt-5 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]" onClick={() => setLocation("/branches")}>إدارة الأفرع</Button></CardContent></Card> : <><section aria-label="الإجراءات الأساسية" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{visiblePrimaryActions.map((action) => { const Icon = action.icon; const tone = toneClasses[action.tone]; return <button key={action.path} type="button" onClick={() => setLocation(action.path)} className={`group min-h-44 rounded-2xl border ${tone.border} bg-[#111823] p-5 text-right shadow-panel transition duration-200 ${tone.hover} active:scale-[.985] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F5B800]`}><div className="flex items-start justify-between gap-4"><span className={`grid h-11 w-11 place-items-center rounded-xl ${tone.icon}`}><Icon className="h-5 w-5" /></span><span className={`text-[11px] font-bold ${tone.label}`}>{action.group}</span></div><h2 className="mt-5 text-lg font-extrabold text-white">{action.label}</h2><p className="mt-2 text-sm leading-6 text-slate-400">{action.description}</p><span className={`mt-4 flex items-center gap-1 text-sm font-bold ${tone.label}`}>فتح الإجراء <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" /></span></button>; })}</section>{!visiblePrimaryActions.length ? <Card className="border-white/8 bg-[#111823]"><CardContent className="p-8 text-center"><h2 className="font-bold text-white">لا توجد إجراءات تشغيلية متاحة لهذا الحساب</h2><p className="mt-2 text-sm text-slate-400">اطلب من مالك المولد مراجعة الصلاحيات الممنوحة لك في الفرع الحالي.</p></CardContent></Card> : null}
      <section className="grid gap-6 xl:grid-cols-[1.25fr_.75fr]"><Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5 sm:p-6"><div className="flex items-center justify-between"><div><h2 className="font-bold text-white">اختصارات المراجعة والمتابعة</h2><p className="mt-1 text-sm text-slate-400">انتقل إلى السجلات والبيانات المساندة دون العودة إلى القائمة الجانبية.</p></div><FileText className="h-5 w-5 text-[#F5B800]" /></div><div className="mt-5 grid gap-3 sm:grid-cols-2">{supportActions.map((action) => { const Icon = action.icon; return <button key={action.path} type="button" onClick={() => setLocation(action.path)} className="group flex items-start gap-3 rounded-xl border border-white/8 bg-white/[.018] p-4 text-right transition hover:border-[#F5B800]/35 hover:bg-[#F5B800]/[.045] active:scale-[.985]"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#F5B800]/10 text-[#F5B800]"><Icon className="h-4 w-4" /></span><span><span className="block font-bold text-white">{action.label}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{action.description}</span></span></button>; })}</div></CardContent></Card><Card className="border-dashed border-[#F5B800]/30 bg-[#F5B800]/[.025] shadow-panel"><CardContent className="p-6"><PackagePlus className="h-6 w-6 text-[#F5B800]" /><h2 className="mt-5 font-bold text-white">الأصناف والمخزون</h2><p className="mt-2 text-sm leading-7 text-slate-400">إضافة المنتجات ليست جزءاً من دورة بيع الكهرباء الحالية. يمكن تفعيلها لاحقاً للمحروقات وقطع الغيار وربطها بالمصروفات والمشتريات.</p><Button variant="outline" onClick={() => toast.info("وحدة الأصناف والمخزون تحتاج نطاقاً مستقلاً قبل تفعيلها محاسبياً.")} className="mt-5 border-[#F5B800]/35 text-[#F5B800] hover:bg-[#F5B800]/10 hover:text-[#ffd23f]">استكشاف وحدة الأصناف</Button></CardContent></Card></section></>}</main></DashboardLayout>;
}
