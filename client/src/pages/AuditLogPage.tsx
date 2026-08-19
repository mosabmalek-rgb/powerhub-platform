import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { ClipboardCheck, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

const actionNames: Record<string, string> = { create: "إنشاء", update: "تحديث", approve: "اعتماد", issue: "إصدار", create_share_link: "رابط مشاركة", assign_role: "تعيين دور", upsert: "حفظ إعداد" };
const entityNames: Record<string, string> = { site: "محطة", subscriber: "مشترك", meter: "عداد", meter_reading: "قراءة", tariff: "تعرفة", generator: "مولد", invoice: "فاتورة", invoice_share_link: "رابط فاتورة", payment: "دفعة", expense: "مصروف", staff_profile: "فريق", tenant_messaging_configuration: "إعداد مراسلة" };

export default function AuditLogPage() {
  const { isAuthenticated, loading } = useAuth();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const [siteId, setSiteId] = useState<number | null>(null);
  useEffect(() => { if (!siteId && sitesQuery.data?.[0]) setSiteId(sitesQuery.data[0].id); }, [siteId, sitesQuery.data]);
  const enabled = Boolean(isAuthenticated && siteId);
  const auditQuery = trpc.powerhub.audit.list.useQuery({ siteId: siteId ?? 0 }, { enabled });
  if (loading) return <DashboardLayout><div className="grid min-h-[55vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  if (!isAuthenticated) return <DashboardLayout><Card className="mx-auto mt-12 max-w-xl border-[#F5B800]/20 bg-[#111823]"><CardContent className="p-8 text-center"><ShieldCheck className="mx-auto h-9 w-9 text-[#F5B800]" /><h1 className="mt-4 text-xl font-extrabold text-white">سجل التدقيق محمي</h1><button className="mt-5 rounded-xl bg-[#F5B800] px-5 py-2 font-bold text-[#0D1117]" onClick={() => startLogin()}>تسجيل الدخول</button></CardContent></Card></DashboardLayout>;
  return <DashboardLayout><div className="space-y-6 pb-12"><header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823] p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><ClipboardCheck className="h-4 w-4" />رقابة وأمان</div><h1 className="mt-1 text-2xl font-extrabold text-white">سجل التدقيق</h1><p className="mt-2 text-sm text-slate-400">آخر 100 عملية حساسة داخل المحطة المحددة، معزولة عن سجلات أي مستأجر آخر.</p></div>{sitesQuery.data?.length ? <select className="h-10 rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white" value={siteId ?? ""} onChange={(e) => setSiteId(Number(e.target.value))}>{sitesQuery.data.map((site) => <option className="bg-[#111823]" key={site.id} value={site.id}>{site.name}</option>)}</select> : null}</header><Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0">{auditQuery.isLoading ? <div className="grid h-48 place-items-center"><Loader2 className="h-6 w-6 animate-spin text-[#F5B800]" /></div> : auditQuery.data?.length ? <div className="divide-y divide-white/7">{auditQuery.data.map((record) => <article key={record.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><Badge className="bg-[#F5B800]/10 text-[#F5B800]">{entityNames[record.entityType] ?? record.entityType}</Badge><span className="font-bold text-white">{actionNames[record.action] ?? record.action}</span></div><p className="mt-2 font-mono text-xs text-slate-500">#{record.entityId}</p></div><time className="text-xs text-slate-400">{new Date(record.createdAt).toLocaleString("ar-IQ")}</time></article>)}</div> : <div className="py-16 text-center text-sm text-slate-500">لا توجد عمليات مسجلة لهذه المحطة حتى الآن.</div>}</CardContent></Card></div></DashboardLayout>;
}
