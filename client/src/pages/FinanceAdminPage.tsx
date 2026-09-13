import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { CircleDollarSign, FileClock, Landmark } from "lucide-react";
import { useEffect } from "react";
import { useLocation } from "wouter";

const subscriptionLabels: Record<string, string> = { trial: "تجريبي", active: "فعّال", overdue: "متأخر", suspended: "معلّق", cancelled: "ملغي" };
const formatNumber = (value: unknown) => new Intl.NumberFormat("ar", { maximumFractionDigits: 2 }).format(Number(value ?? 0));
type SubscriptionSummary = { status: string; count: number };


export default function FinanceAdminPage() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();
  const isFinanceAdmin = user?.role === "admin" && user.platformRole === "finance_admin";
  const overview = trpc.admin.financeOverview.useQuery(undefined, { enabled: isFinanceAdmin });

  useEffect(() => {
    if (!loading && !isFinanceAdmin) setLocation(user?.role === "admin" ? "/admin" : "/");
  }, [isFinanceAdmin, loading, setLocation, user?.role]);

  if (loading || !isFinanceAdmin) return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">جارٍ فتح المساحة المصرح بها…</h1></div></main>;

  return <DashboardLayout><main className="space-y-6 pb-12"><header className="rounded-[26px] border border-[#F5B800]/20 bg-[#111823]/85 p-6 shadow-panel"><div className="flex items-start gap-3"><span className="grid h-11 w-11 place-items-center rounded-xl bg-[#F5B800]/10 text-[#F5B800]"><Landmark className="h-5 w-5" /></span><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><CircleDollarSign className="h-4 w-4" />إدارة مالية محدودة</div><h1 className="mt-2 text-2xl font-extrabold text-white">الملخص المالي للمنصة</h1><p className="mt-2 max-w-2xl text-sm leading-7 text-slate-400">تعرض هذه المساحة ملخص الاشتراكات والتحصيل فقط. لا تمنح صلاحية إدارة المولدات أو المستخدمين أو أدوار المنصة.</p></div></div></header><section className="grid gap-4 sm:grid-cols-2"><Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><CircleDollarSign className="h-5 w-5 text-emerald-400" /><p className="mt-5 text-sm text-slate-400">إجمالي التحصيل المكتمل</p><p className="mt-2 font-display text-3xl font-extrabold text-white">{formatNumber(overview.data?.collections.amount)}</p><p className="mt-2 text-xs text-slate-500">{formatNumber(overview.data?.collections.count)} دفعة مكتملة</p></CardContent></Card><Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><FileClock className="h-5 w-5 text-[#F5B800]" /><p className="mt-5 text-sm text-slate-400">حالات اشتراكات أصحاب المولدات</p><p className="mt-2 font-display text-3xl font-extrabold text-white">{formatNumber(((overview.data?.subscriptions ?? []) as SubscriptionSummary[]).reduce((total: number, item: SubscriptionSummary) => total + item.count, 0))}</p><p className="mt-2 text-xs text-slate-500">إجمالي المساحات المسجلة في الملخص</p></CardContent></Card></section><Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><h2 className="font-bold text-white">تفصيل حالات الاشتراك</h2><div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{((overview.data?.subscriptions ?? []) as SubscriptionSummary[]).map((item: SubscriptionSummary) => <div key={item.status} className="flex items-center justify-between rounded-xl border border-white/8 bg-white/[.02] p-4"><span className="text-sm text-slate-300">{subscriptionLabels[item.status] ?? item.status}</span><Badge className="bg-[#F5B800]/10 text-[#F5B800]">{formatNumber(item.count)}</Badge></div>)}{!overview.data?.subscriptions.length && <p className="col-span-full py-8 text-center text-sm text-slate-500">لا توجد بيانات اشتراك مسجلة حالياً.</p>}</div></CardContent></Card></main></DashboardLayout>;
}
