import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { ArrowLeft, CheckCircle2, Gauge, Settings2, UsersRound, Zap } from "lucide-react";

const steps = [
  { key: "branch", title: "إعداد الفرع", description: "تأكد من وجود فرع نشط ومعلوماته الأساسية.", path: "/branches", icon: Settings2 },
  { key: "generator", title: "إضافة المولد", description: "أضف بيانات المولد الذي ستدار منه عملية بيع الكهرباء.", path: "/generators", icon: Zap },
  { key: "tariff", title: "إعداد التسعيرة", description: "أنشئ تسعيرة فعالة قبل إصدار الفواتير.", path: "/settings", icon: Gauge },
  { key: "subscribers", title: "إضافة المشتركين", description: "أدخل المشتركين أو استوردهم من Excel.", path: "/subscribers", icon: UsersRound },
  { key: "reading", title: "أول قراءة", description: "سجل قراءة عداد معتمدة لبدء الدورة التشغيلية.", path: "/readings", icon: Gauge },
];

export default function SetupWizardPage() {
  const { isAuthenticated, loading, user } = useAuth();
  const [, setLocation] = useLocation();
  const branches = trpc.powerhub.sites.list.useQuery(undefined, { enabled: Boolean(isAuthenticated) });
  const { branchId } = useBranchFilter(branches.data ?? []);
  const enabled = Boolean(isAuthenticated && branchId);
  const generators = trpc.powerhub.generators.list.useQuery({ siteId: branchId ?? 0 }, { enabled });
  const tariffs = trpc.powerhub.tariffs.list.useQuery({ siteId: branchId ?? 0 }, { enabled });
  const subscribers = trpc.powerhub.subscribers.list.useQuery({ siteId: branchId ?? 0 }, { enabled });

  const counts = {
    branch: (branches.data ?? []).filter((item: any) => item.status !== "archived").length,
    generator: (generators.data ?? []).length,
    tariff: (tariffs.data ?? []).filter((item: any) => item.isActive !== false).length,
    subscribers: (subscribers.data ?? []).length,
  };

  const completed = (key: string) => key === "branch" ? counts.branch > 0 : key === "generator" ? counts.generator > 0 : key === "tariff" ? counts.tariff > 0 : key === "subscribers" ? counts.subscribers > 0 : false;
  const completedCount = steps.filter((step) => completed(step.key)).length;
  const firstIncomplete = steps.find((step) => !completed(step.key));

  if (loading) return <DashboardLayout><div className="grid min-h-[60vh] place-items-center text-slate-400">جارٍ تحميل إعداد المساحة…</div></DashboardLayout>;
  if (!isAuthenticated) return <DashboardLayout><Card><CardContent className="p-8 text-center">يجب تسجيل الدخول للوصول إلى إعداد PowerHub.</CardContent></Card></DashboardLayout>;
  if (user?.role === "admin") return <DashboardLayout><Card><CardContent className="p-8 text-center"><p className="font-bold">إعداد العملاء يتم من مركز إدارة المنصة.</p><Button className="mt-4" onClick={() => setLocation("/admin")}>العودة إلى الإدارة</Button></CardContent></Card></DashboardLayout>;

  return <DashboardLayout><main className="mx-auto max-w-5xl space-y-6 pb-12" dir="rtl">
    <header className="rounded-[26px] border border-[#F5B800]/20 bg-[#111823] p-6 shadow-panel">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div><Badge className="bg-[#F5B800]/10 text-[#F5B800]">بدء التشغيل</Badge><h1 className="mt-3 text-2xl font-extrabold text-white">إعداد PowerHub لأول مرة</h1><p className="mt-2 max-w-2xl text-sm leading-7 text-slate-400">أكمل الخطوات الأساسية بالترتيب. لا تحتاج هذه الصفحة إلى تعديل قاعدة البيانات أو تدخل المطور.</p></div>
        <div className="rounded-2xl border border-white/10 bg-white/[.03] px-5 py-4 text-center"><p className="text-xs text-slate-500">التقدم</p><p className="mt-1 text-2xl font-extrabold text-white">{completedCount}/{steps.length}</p></div>
      </div>
    </header>

    <section className="grid gap-4">
      {steps.map((step, index) => { const done = completed(step.key); const Icon = step.icon; const active = !done && firstIncomplete?.key === step.key; return <Card key={step.key} className={`${active ? "border-[#F5B800]/35" : done ? "border-emerald-400/20" : "border-white/8"} bg-[#111823]`}><CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
        <div className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl ${done ? "bg-emerald-400/10 text-emerald-300" : active ? "bg-[#F5B800]/10 text-[#F5B800]" : "bg-white/[.04] text-slate-500"}`}>{done ? <CheckCircle2 className="h-6 w-6" /> : <Icon className="h-6 w-6" />}</div>
        <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-xs text-slate-500">الخطوة {index + 1}</span><h2 className="font-bold text-white">{step.title}</h2><Badge className={done ? "bg-emerald-400/10 text-emerald-300" : active ? "bg-[#F5B800]/10 text-[#F5B800]" : "bg-white/5 text-slate-400"}>{done ? "مكتملة" : active ? "التالية" : "بانتظارها"}</Badge></div><p className="mt-1 text-sm leading-6 text-slate-400">{step.description}</p></div>
        <Button variant={done ? "outline" : "default"} onClick={() => setLocation(step.path)} className={done ? "border-white/10 text-white hover:bg-white/5 hover:text-white" : "bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"}>{done ? "مراجعة" : "فتح الخطوة"}<ArrowLeft className="mr-2 h-4 w-4" /></Button>
      </CardContent></Card>; })}
    </section>

    <Card className="border-sky-400/15 bg-sky-400/[.04]"><CardContent className="p-5 text-sm leading-7 text-sky-100"><strong>ملاحظة تشغيلية:</strong> تطبيق الميدان يبقى مخصصاً لتسجيل ومزامنة قراءات العدادات في هذه المرحلة؛ التحصيل والدفع يتمان من مساحة التشغيل وليس من مسار القراءة الميداني.</CardContent></Card>
  </main></DashboardLayout>;
}
