import PlatformAdminLayout from "@/components/PlatformAdminLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { ArrowRight, CalendarDays, Clock3, PackageCheck, UsersRound, Zap } from "lucide-react";
import { useLocation, useRoute } from "wouter";

const number = (v: unknown) => new Intl.NumberFormat("ar-PS").format(Number(v ?? 0));
const date = (v: unknown) => v ? new Intl.DateTimeFormat("ar-PS", { dateStyle: "medium" }).format(new Date(String(v))) : "—";
const resourceLabels: Record<string,string> = { subscribers:"المشتركون", branches:"الأفرع", messages:"الرسائل", platformUsers:"مستخدمو المنصة", fieldUsers:"التطبيق الميداني" };

function LimitCard({ label, used, limit }: { label:string; used:number; limit:number }) {
  const pct = limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 0;
  return <div className="rounded-2xl border border-white/8 bg-white/[.018] p-4"><p className="text-xs text-slate-500">{label}</p><p className="mt-2 text-2xl font-extrabold text-white">{number(limit)}</p><p className="mt-1 text-xs text-slate-400">المستخدم {number(used)} · المتبقي {number(Math.max(0, limit-used))}</p><div className="mt-3 h-2 overflow-hidden rounded-full bg-black/30"><div className={pct>=100?"h-full rounded-full bg-rose-400":pct>=80?"h-full rounded-full bg-amber-300":"h-full rounded-full bg-emerald-400"} style={{width:`${pct}%`}} /></div><p className="mt-2 text-xs font-bold text-slate-300">{pct}%</p></div>;
}

export default function AdminOwnerSubscriptionProfilePage() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/admin/owner-subscriptions/:tenantId");
  const tenantId = Number(params?.tenantId ?? 0);
  const report = trpc.admin.ownerQuotaUsageReport.useQuery(undefined, { staleTime: 15000, enabled: tenantId > 0 });
  const row = (report.data ?? []).find((item:any) => Number(item.tenant.id) === tenantId);
  return <PlatformAdminLayout activeTab="ownerSubscription" onTabChange={(tab) => { if (tab === "ownerSubscription") navigate("/admin"); else navigate("/admin"); }}>
    <main className="space-y-6 pb-12">
      <div className="flex items-center gap-3"><Button variant="outline" onClick={() => navigate("/admin")} className="border-white/10 text-white hover:bg-white/5 hover:text-white"><ArrowRight className="ml-1 h-4 w-4" />اشتراكات أصحاب المولدات</Button><div><p className="text-xs font-bold text-[#F5B800]">ملف الاشتراك</p><h1 className="text-2xl font-extrabold text-white">{row?.owner?.companyName ?? row?.tenant?.name ?? "صاحب المولد"}</h1><p className="mt-1 text-sm text-slate-500">{row?.owner?.fullName ?? "—"} · {row?.tenant?.name ?? "—"}</p></div></div>
      {report.isLoading && <Card className="border-white/8 bg-[#111823]"><CardContent className="p-8 text-center text-slate-400">جارٍ تحميل ملف صاحب المولد…</CardContent></Card>}
      {!report.isLoading && !row && <Card className="border-rose-400/20 bg-[#111823]"><CardContent className="p-8 text-center text-rose-300">لم يتم العثور على اشتراك صاحب المولد.</CardContent></Card>}
      {row && <><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="border-white/8 bg-[#111823]"><CardContent className="p-5"><CalendarDays className="h-5 w-5 text-[#F5B800]" /><p className="mt-3 text-xs text-slate-500">تاريخ الالتحاق</p><p className="mt-1 font-bold text-white">{date(row.tenant.createdAt)}</p></CardContent></Card>
        <Card className="border-white/8 bg-[#111823]"><CardContent className="p-5"><PackageCheck className="h-5 w-5 text-[#F5B800]" /><p className="mt-3 text-xs text-slate-500">الباقة</p><p className="mt-1 font-bold text-white">{row.package.name}</p><p className="mt-1 text-xs text-slate-500">{row.subscription.packageCode} · {row.subscription.status}</p></CardContent></Card>
        <Card className="border-white/8 bg-[#111823]"><CardContent className="p-5"><Clock3 className="h-5 w-5 text-[#F5B800]" /><p className="mt-3 text-xs text-slate-500">مدة الاشتراك</p><p className="mt-1 font-bold text-white">{date(row.subscription.startedAt)} → {date(row.subscription.endsAt)}</p><p className="mt-1 text-xs text-slate-500">المتبقي: {row.daysRemaining == null ? "—" : row.daysRemaining + " يوم"}</p></CardContent></Card>
        <Card className="border-white/8 bg-[#111823]"><CardContent className="p-5"><UsersRound className="h-5 w-5 text-[#F5B800]" /><p className="mt-3 text-xs text-slate-500">المشتركون</p><p className="mt-1 text-2xl font-extrabold text-white">{number(row.usage.subscribers)} / {number(row.limits.subscribers)}</p></CardContent></Card>
      </div>
      <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-5"><h2 className="font-bold text-white">حدود الباقة والاستهلاك</h2><p className="mt-1 text-sm text-slate-400">الحدود هنا هي الحدود الفعلية بعد احتساب الإضافات والاستثناءات، وليست حدود الكتالوج فقط.</p><div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><LimitCard label={resourceLabels.subscribers} used={row.usage.subscribers} limit={row.limits.subscribers}/><LimitCard label={resourceLabels.branches} used={row.usage.branches} limit={row.limits.branches}/><LimitCard label={resourceLabels.messages} used={row.messages.used} limit={row.limits.messages}/><LimitCard label={resourceLabels.platformUsers} used={row.usage.platformUsers} limit={row.limits.platformUsers}/><LimitCard label={resourceLabels.fieldUsers} used={row.usage.fieldUsers} limit={row.limits.fieldUsers}/></div></CardContent></Card>
      <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-center gap-2"><Zap className="h-5 w-5 text-[#F5B800]"/><h2 className="font-bold text-white">الإضافات الفعالة</h2></div>{row.addons.length ? <div className="mt-4 grid gap-3 md:grid-cols-2">{row.addons.map((addon:any)=><div key={addon.id} className="rounded-xl border border-white/8 bg-white/[.018] p-4"><p className="font-bold text-white">{addon.code}</p><p className="mt-1 text-sm text-slate-300">الكمية: {number(addon.quantity)}</p><p className="mt-1 text-xs text-slate-500">{date(addon.startsAt)} → {date(addon.endsAt)} · {addon.durationDays ?? "—"} يوم</p></div>)}</div> : <p className="mt-4 rounded-xl border border-dashed border-white/10 p-5 text-sm text-slate-500">لا توجد إضافات فعالة حاليًا.</p>}</CardContent></Card></>}
    </main>
  </PlatformAdminLayout>;
}
