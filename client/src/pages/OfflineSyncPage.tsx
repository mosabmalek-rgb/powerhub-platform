import DashboardLayout from "@/components/DashboardLayout";
import { OfflineWorkSyncPanel } from "@/components/OfflineWorkSyncPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { startLogin } from "@/const";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { CloudOff, Loader2 } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { usePowerHubConnectivity } from "@/lib/offline-connectivity";
import { isExplicitAuthorizationDenial } from "@/lib/offline-query-errors";

const inputClass = "h-10 rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";

export default function OfflineSyncPage() {
  const { isAuthenticated, loading, user } = useAuth();
  const { isOnline, isChecking } = usePowerHubConnectivity();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: Boolean(isAuthenticated && isOnline && !isChecking), refetchOnReconnect: true });
  const siteAccessDenied = isExplicitAuthorizationDenial(sitesQuery.error);
  const { branchId: siteId, setBranchId: setSiteId } = useBranchFilter(sitesQuery.data);

  if (loading) return <DashboardLayout><div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  if (!isAuthenticated) return <DashboardLayout><Card className="mx-auto mt-12 max-w-xl border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-8 text-center"><CloudOff className="mx-auto h-8 w-8 text-[#F5B800]" /><h1 className="mt-5 text-xl font-extrabold text-white">سجّل الدخول لمراجعة المسودات</h1><p className="mt-3 text-sm leading-7 text-slate-400">ترتبط كل مسودة محلية بالمستخدم الذي أنشأها وبفرع محدد.</p><Button onClick={() => startLogin()} className="mt-6 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">تسجيل الدخول</Button></CardContent></Card></DashboardLayout>;
  if (isChecking) return <DashboardLayout><Card role="status" className="mx-auto mt-12 max-w-xl border-sky-400/25 bg-[#111823] shadow-panel"><CardContent className="p-8 text-center"><Loader2 className="mx-auto h-8 w-8 animate-spin text-sky-200" /><h1 className="mt-5 text-xl font-extrabold text-white">نتحقق من اتصال PowerHub</h1><p className="mt-3 text-sm leading-7 text-slate-400">لم نعتبر الفرع مفقوداً ولم نلمس المسودات المحلية أثناء فحص الاتصال.</p></CardContent></Card></DashboardLayout>;
  if (sitesQuery.isLoading && isOnline && !isChecking) return <DashboardLayout><div className="grid min-h-[40vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  if (siteAccessDenied) return <DashboardLayout><Card role="alert" className="mx-auto mt-12 max-w-xl border-rose-400/25 bg-[#111823] shadow-panel"><CardContent className="p-8 text-center"><CloudOff className="mx-auto h-8 w-8 text-rose-300" /><h1 className="mt-5 text-xl font-extrabold text-white">رفض الخادم الوصول إلى قائمة الفروع</h1><p className="mt-3 text-sm leading-7 text-slate-400">أوقفنا عرض المسودات لهذا النطاق بدل استخدام قائمة فروع قديمة. لم نحذف أي عملية من Outbox؛ أعد المحاولة عند توفر الاتصال والتحقق من الصلاحيات.</p><Button disabled={!isOnline || isChecking} onClick={() => void sitesQuery.refetch()} className="mt-6 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">إعادة التحقق</Button></CardContent></Card></DashboardLayout>;
  if ((!sitesQuery.data?.length || !siteId) && (!isOnline || isChecking || sitesQuery.isError)) return <DashboardLayout><Card role="status" className="mx-auto mt-12 max-w-xl border-amber-300/25 bg-[#111823] shadow-panel"><CardContent className="p-8 text-center"><CloudOff className="mx-auto h-8 w-8 text-amber-200" /><h1 className="mt-5 text-xl font-extrabold text-white">تعذر تحديد فرع للمسودات المحلية</h1><p className="mt-3 text-sm leading-7 text-slate-400">لا توجد قائمة فروع موثوقة متاحة في هذه الجلسة. الانقطاع لا يعني عدم وجود فرع؛ لا نعرض مسودات خارج نطاق محدد، ولم نحذف أو نعدّل أي عملية محلية.</p><Button disabled={!isOnline || isChecking} onClick={() => void sitesQuery.refetch()} variant="outline" className="mt-6 border-white/10 text-slate-200">إعادة المحاولة</Button></CardContent></Card></DashboardLayout>;
  if (!sitesQuery.data?.length || !siteId || !user?.id) return <DashboardLayout><div className="mx-auto mt-12 max-w-xl rounded-[28px] border border-white/10 bg-[#111823] p-8 text-center text-slate-400">لا يوجد فرع تشغيلي متاح لهذا الحساب. اختر/أنشئ فرعاً بعد التحقق من الصلاحيات.</div></DashboardLayout>;

  return <DashboardLayout><div className="space-y-6 pb-12"><header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823]/80 p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><CloudOff className="h-4 w-4" />العمل دون اتصال</div><h1 className="mt-1 text-2xl font-extrabold text-white">مركز مزامنة المسودات</h1><p className="mt-2 text-sm text-slate-400">راجع وأرسل مسودات المشتركين والفواتير عند عودة الاتصال. التعارضات لا تُدمج تلقائياً.</p></div><select aria-label="فلتر الفرع الموحد" value={siteId} onChange={(event) => setSiteId(Number(event.target.value))} className={inputClass}>{sitesQuery.data.map((site) => <option className="bg-[#111823]" key={site.id} value={site.id}>{site.name}</option>)}</select></header><OfflineWorkSyncPanel siteId={siteId} userId={user.id} /></div></DashboardLayout>;
}
