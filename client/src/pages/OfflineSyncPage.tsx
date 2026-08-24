import DashboardLayout from "@/components/DashboardLayout";
import { OfflineWorkSyncPanel } from "@/components/OfflineWorkSyncPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { startLogin } from "@/const";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { CloudOff, Loader2 } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";

const inputClass = "h-10 rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";

export default function OfflineSyncPage() {
  const { isAuthenticated, loading, user } = useAuth();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const { branchId: siteId, setBranchId: setSiteId } = useBranchFilter(sitesQuery.data);

  if (loading) return <DashboardLayout><div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  if (!isAuthenticated) return <DashboardLayout><Card className="mx-auto mt-12 max-w-xl border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-8 text-center"><CloudOff className="mx-auto h-8 w-8 text-[#F5B800]" /><h1 className="mt-5 text-xl font-extrabold text-white">سجّل الدخول لمراجعة المسودات</h1><p className="mt-3 text-sm leading-7 text-slate-400">ترتبط كل مسودة محلية بالمستخدم الذي أنشأها وبفرع محدد.</p><Button onClick={() => startLogin()} className="mt-6 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">تسجيل الدخول</Button></CardContent></Card></DashboardLayout>;
  if (!sitesQuery.data?.length || !siteId || !user?.id) return <DashboardLayout><div className="mx-auto mt-12 max-w-xl rounded-[28px] border border-white/10 bg-[#111823] p-8 text-center text-slate-400">أنشئ فرعاً أولاً للوصول إلى المسودات المحلية.</div></DashboardLayout>;

  return <DashboardLayout><div className="space-y-6 pb-12"><header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823]/80 p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><CloudOff className="h-4 w-4" />العمل دون اتصال</div><h1 className="mt-1 text-2xl font-extrabold text-white">مركز مزامنة المسودات</h1><p className="mt-2 text-sm text-slate-400">راجع وأرسل مسودات المشتركين والفواتير عند عودة الاتصال. التعارضات لا تُدمج تلقائياً.</p></div><select aria-label="فلتر الفرع الموحد" value={siteId} onChange={(event) => setSiteId(Number(event.target.value))} className={inputClass}>{sitesQuery.data.map((site) => <option className="bg-[#111823]" key={site.id} value={site.id}>{site.name}</option>)}</select></header><OfflineWorkSyncPanel siteId={siteId} userId={user.id} /></div></DashboardLayout>;
}
