import PlatformAdminLayout from "@/components/PlatformAdminLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { ArrowRight, RotateCcw, Save, Search, Settings2, UsersRound, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation, useRoute } from "wouter";

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[.025] px-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-[#F5B800]/70";
const numberFormat = (value: unknown) => new Intl.NumberFormat("ar").format(Number(value ?? 0));

const categoryLabels: Record<string,string> = {
  "التشغيل":"التشغيل",
  "المراسلات":"المراسلات",
  "المستخدمون":"المستخدمون",
  "بوابة المشترك":"بوابة المشترك",
  "المدفوعات":"المدفوعات",
  "التقارير":"التقارير",
  "المالية":"المالية",
  "الموارد البشرية":"الموارد البشرية",
};

function policyLabel(policy: string | undefined) {
  return policy === "included" ? "مشمولة" : policy === "addon" ? "إضافة" : "غير متاحة";
}

function FeatureControlsIndex() {
  const [,navigate] = useLocation();
  const featureAdmin = trpc.admin as any;
  const owners = featureAdmin.tenantFeatureMatrix.useQuery();
  const [query,setQuery] = useState("");
  const rows = useMemo(() => {
    const value=query.trim().toLowerCase();
    return (owners.data ?? []).filter((row:any) => !value || [row.owner?.fullName,row.tenant?.name,row.owner?.companyName,row.subscription?.packageCode].some((item:any)=>String(item ?? "").toLowerCase().includes(value)));
  },[owners.data,query]);

  return <PlatformAdminLayout activeTab="features" onTabChange={(tab) => { if(tab === "features") return; navigate("/admin"); }}>
    <main className="space-y-6 pb-12">
      <header className="rounded-[26px] border border-[#F5B800]/20 bg-[#111823]/85 p-6 shadow-panel">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Settings2 className="h-4 w-4" />الميزات والحدود</div><h1 className="mt-2 text-2xl font-extrabold text-white">مصفوفة التحكم بأصحاب المولدات</h1><p className="mt-2 max-w-3xl text-sm leading-7 text-slate-400">كل صاحب مولد له سياسة فعالة مستقلة. الباقة هي الأساس، والتعديلات اليدوية تُحفظ كاستثناءات منفصلة مع سجل تدقيق.</p></div>
          <div className="w-full lg:w-80"><label className="mb-2 block text-xs font-bold text-slate-400">بحث عن صاحب مولد</label><div className="relative"><Search className="absolute right-3 top-3 h-4 w-4 text-slate-500"/><Input value={query} onChange={e=>setQuery(e.target.value)} placeholder="الاسم أو المساحة أو الباقة" className={inputClass+" pr-10"}/></div></div>
        </div>
      </header>
      <Card className="border-white/8 bg-[#111823] shadow-panel">
        <CardContent className="p-0">
          <div className="overflow-x-auto"><table className="w-full min-w-[1000px] text-right text-sm">
            <thead className="border-b border-white/8 text-xs text-slate-500"><tr><th className="px-5 py-4">صاحب المولد</th><th className="px-4 py-4">الباقة</th><th className="px-4 py-4">الحالة</th><th className="px-4 py-4">المشتركون</th><th className="px-4 py-4">الفروع</th><th className="px-4 py-4">المستخدمون</th><th className="px-4 py-4">الإجراء</th></tr></thead>
            <tbody>{rows.map((row:any)=><tr key={row.tenant.id} className="border-t border-white/7 hover:bg-white/[.02]"><td className="px-5 py-4"><p className="font-bold text-white">{row.owner?.fullName ?? "غير محدد"}</p><p className="mt-1 text-xs text-slate-500">{row.tenant.name}</p></td><td className="px-4 py-4"><Badge className="bg-[#F5B800]/10 text-[#F5B800]">{row.subscription?.packageCode ?? row.tenant.legacyPlan ?? "—"}</Badge></td><td className="px-4 py-4"><Badge className={["active","trial"].includes(row.subscription?.status) ? "bg-emerald-400/10 text-emerald-300" : "bg-slate-400/10 text-slate-400"}>{row.subscription?.status === "trial" ? "تجريبي" : row.subscription?.status === "active" ? "نشط" : row.subscription?.status ?? "غير مهيأ"}</Badge></td><td className="px-4 py-4 text-slate-300">{numberFormat(row.usage?.subscribers)}</td><td className="px-4 py-4 text-slate-300">{numberFormat(row.usage?.branches)}</td><td className="px-4 py-4 text-slate-300">{numberFormat((row.usage?.platformUsers ?? 0) + (row.usage?.fieldUsers ?? 0))}</td><td className="px-4 py-4"><Button size="sm" onClick={()=>navigate("/admin/generator-features/"+row.tenant.id)} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">إدارة الميزات</Button></td></tr>)}{!rows.length && <tr><td colSpan={7} className="py-12 text-center text-sm text-slate-500">{owners.isLoading ? "جارٍ تحميل أصحاب المولدات…" : "لا توجد نتائج."}</td></tr>}</tbody>
          </table></div>
        </CardContent>
      </Card>
    </main>
  </PlatformAdminLayout>;
}

function FeatureRow({feature,policy,control,onSave,onReset,pending}:{feature:any;policy:any;control:any;onSave:(v:any)=>void;onReset:()=>void;pending:boolean}) {
  const [status,setStatus]=useState(control?.status ?? "inherit");
  const [limitMode,setLimitMode]=useState(control?.limitMode ?? "inherit");
  const [manualLimit,setManualLimit]=useState(control?.manualLimit == null ? "" : String(control.manualLimit));
  const [reason,setReason]=useState(control?.overrideReason ?? "");
  const effectiveEligible = policy?.policy === "included" || policy?.policy === "addon";
  const effectiveEnabled = status === "enabled" || (status === "inherit" && policy?.policy === "included");
  const effectiveLimit = limitMode === "manual" ? manualLimit : limitMode === "unlimited" ? "غير محدود" : policy?.defaultLimit == null ? "—" : numberFormat(policy.defaultLimit);
  const dirty = status !== (control?.status ?? "inherit") || limitMode !== (control?.limitMode ?? "inherit") || (limitMode === "manual" ? manualLimit !== String(control?.manualLimit ?? "") : control?.manualLimit != null) || reason !== (control?.overrideReason ?? "");
  return <div className="rounded-2xl border border-white/8 bg-white/[.018] p-4">
    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
      <div className="min-w-0 xl:w-[32%]"><div className="flex items-center gap-2"><p className="font-bold text-white">{feature.name}</p><Badge className={effectiveEnabled ? "bg-emerald-400/10 text-emerald-300" : "bg-slate-400/10 text-slate-400"}>{effectiveEnabled ? "فعّالة" : "غير فعّالة"}</Badge></div><p className="mt-1 text-xs leading-6 text-slate-500">{feature.description}</p><div className="mt-2 flex flex-wrap gap-2 text-[11px]"><Badge className="bg-white/5 text-slate-400">{categoryLabels[feature.category] ?? feature.category}</Badge><Badge className={policy?.policy === "addon" ? "bg-amber-400/10 text-amber-300" : policy?.policy === "included" ? "bg-sky-400/10 text-sky-300" : "bg-rose-400/10 text-rose-300"}>{policyLabel(policy?.policy)}</Badge></div></div>
      <div className="grid flex-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="text-xs text-slate-500">الحالة<select value={status} onChange={e=>setStatus(e.target.value)} className={inputClass+" mt-1"}><option value="inherit">حسب الباقة</option><option value="enabled" disabled={!effectiveEligible}>تفعيل يدوي</option><option value="disabled">تعطيل يدوي</option></select></label>
        <label className="text-xs text-slate-500">نمط الحد<select value={limitMode} onChange={e=>setLimitMode(e.target.value)} className={inputClass+" mt-1"}><option value="inherit">حسب الباقة</option><option value="manual">حد يدوي</option><option value="unlimited">غير محدود</option></select></label>
        <label className="text-xs text-slate-500">الحد الفعلي<div className="mt-1 flex h-10 items-center rounded-xl border border-white/10 bg-black/10 px-3 text-sm text-white">{effectiveLimit}</div></label>
        <label className="text-xs text-slate-500">سبب التعديل<Input value={reason} onChange={e=>setReason(e.target.value)} maxLength={2000} placeholder="اختياري" className="mt-1"/></label>
      </div>
      <div className="flex shrink-0 gap-2 xl:pt-6">
        {limitMode === "manual" && <Input value={manualLimit} onChange={e=>setManualLimit(e.target.value.replace(/\D/g,""))} inputMode="numeric" className="w-28" placeholder="الحد" dir="ltr"/>}
        <Button size="sm" disabled={!dirty || pending || (limitMode === "manual" && manualLimit === "")} onClick={()=>onSave({status,limitMode,manualLimit:limitMode === "manual" ? Number(manualLimit) : null,reason})} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><Save className="ml-1 h-4 w-4"/>حفظ</Button>
        {control && <Button size="sm" variant="outline" disabled={pending} onClick={onReset} className="border-white/10 text-slate-300 hover:bg-white/5 hover:text-white"><RotateCcw className="ml-1 h-4 w-4"/>إرجاع للباقة</Button>}
      </div>
    </div>
  </div>;
}

function FeatureControlsDetail({tenantId}:{tenantId:number}) {
  const [,navigate]=useLocation();
  const featureAdmin = trpc.admin as any;
  const snapshot=featureAdmin.tenantFeatureSnapshot.useQuery({tenantId});
  const features=featureAdmin.featureCatalog.useQuery();
  const utils=trpc.useUtils();
  const save=featureAdmin.setTenantFeatureControl.useMutation({onSuccess:()=>{void (utils.admin as any).tenantFeatureSnapshot.invalidate({tenantId});toast.success("تم حفظ سياسة الميزة.");},onError:(e:Error)=>toast.error(e.message)});
  const reset=featureAdmin.resetTenantFeatureControl.useMutation({onSuccess:()=>{void (utils.admin as any).tenantFeatureSnapshot.invalidate({tenantId});toast.success("تمت إعادة الميزة إلى إعدادات الباقة.");},onError:(e:Error)=>toast.error(e.message)});
  const policyByKey=new Map((snapshot.data?.packagePolicies ?? []).map((p:any)=>[p.featureKey,p]));
  const controlByKey=new Map((snapshot.data?.controls ?? []).map((c:any)=>[c.featureKey,c]));
  const groups=useMemo<[string, any[]][]>(()=>{const all=features.data ?? [];return Object.entries(all.reduce((acc:any,f:any)=>{(acc[f.category]??=[]).push(f);return acc;},{} as Record<string,any[]>)) as [string, any[]][];},[features.data]);
  const tenant=snapshot.data?.tenant;
  return <PlatformAdminLayout activeTab="features" onTabChange={tab=>{if(tab === "features") {navigate("/admin/generator-features"); return;} navigate("/admin");}}>
    <main className="space-y-6 pb-12">
      <div className="flex items-center gap-3"><Button variant="outline" onClick={()=>navigate("/admin/generator-features")} className="border-white/10 text-white hover:bg-white/5 hover:text-white"><ArrowRight className="ml-1 h-4 w-4"/>أصحاب المولدات</Button><div><p className="text-xs font-bold text-[#F5B800]">الميزات والحدود</p><h1 className="text-2xl font-extrabold text-white">{snapshot.data?.owner?.fullName ?? tenant?.name ?? "تفاصيل صاحب المولد"}</h1><p className="mt-1 text-sm text-slate-500">{tenant?.name ?? "—"} · الباقة {snapshot.data?.subscription?.packageCode ?? "—"}</p></div></div>
      <div className="grid gap-4 md:grid-cols-4"><Card className="border-white/8 bg-[#111823]"><CardContent className="p-4"><UsersRound className="h-5 w-5 text-[#F5B800]"/><p className="mt-3 text-xs text-slate-500">المشتركون</p><p className="mt-1 text-2xl font-extrabold text-white">{numberFormat(snapshot.data?.usage.subscribers)}</p></CardContent></Card><Card className="border-white/8 bg-[#111823]"><CardContent className="p-4"><Zap className="h-5 w-5 text-[#F5B800]"/><p className="mt-3 text-xs text-slate-500">الفروع</p><p className="mt-1 text-2xl font-extrabold text-white">{numberFormat(snapshot.data?.usage.branches)}</p></CardContent></Card><Card className="border-white/8 bg-[#111823]"><CardContent className="p-4"><UsersRound className="h-5 w-5 text-[#F5B800]"/><p className="mt-3 text-xs text-slate-500">مستخدمو المنصة</p><p className="mt-1 text-2xl font-extrabold text-white">{numberFormat(snapshot.data?.usage.platformUsers)}</p></CardContent></Card><Card className="border-white/8 bg-[#111823]"><CardContent className="p-4"><Zap className="h-5 w-5 text-[#F5B800]"/><p className="mt-3 text-xs text-slate-500">المستخدمون الميدانيون</p><p className="mt-1 text-2xl font-extrabold text-white">{numberFormat(snapshot.data?.usage.fieldUsers)}</p></CardContent></Card></div>
      <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="mb-5"><h2 className="font-bold text-white">مصفوفة الميزات والتحكم</h2><p className="mt-1 text-sm leading-7 text-slate-500">لا يتغير إعداد الباقة نفسه. التعديل هنا استثناء لهذا صاحب المولد فقط.</p></div><div className="space-y-4">{groups.map(([category,list])=><section key={category}><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-extrabold text-[#F5B800]">{category}</h3><span className="text-xs text-slate-600">{list.length} ميزات</span></div><div className="space-y-3">{list.map((feature:any)=><FeatureRow key={feature.feature_key} feature={feature} policy={policyByKey.get(feature.feature_key)} control={controlByKey.get(feature.feature_key)} pending={save.isPending||reset.isPending} onSave={(v)=>save.mutate({tenantId,featureKey:feature.feature_key,...v})} onReset={()=>reset.mutate({tenantId,featureKey:feature.feature_key,reason:"إعادة ضبط من لوحة الميزات والحدود"})}/>)}</div></section>)}</div></CardContent></Card>
    </main>
  </PlatformAdminLayout>;
}

export default function AdminGeneratorFeaturesPage() {
  const [match,params]=useRoute("/admin/generator-features/:tenantId");
  if(match && params?.tenantId) return <FeatureControlsDetail tenantId={Number(params.tenantId)}/>;
  return <FeatureControlsIndex/>;
}
