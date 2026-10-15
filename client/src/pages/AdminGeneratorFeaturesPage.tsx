import PlatformAdminLayout from "@/components/PlatformAdminLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { ArrowRight, Plus, Search, Settings2, UsersRound, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  const features = featureAdmin.featureCatalog.useQuery();
  const utils = trpc.useUtils();
  const setGlobal = featureAdmin.setGlobalFeature.useMutation({
    onSuccess: () => { void (utils.admin as any).featureCatalog.invalidate(); toast.success("تم تحديث إتاحة الميزة على مستوى المنصة."); },
    onError: (e: Error) => toast.error(e.message),
  });
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
      <Card className="border-sky-400/20 bg-[#111823] shadow-panel">
        <CardContent className="p-5">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div><h2 className="font-bold text-white">الميزات العامة للمنصة</h2><p className="mt-1 text-sm leading-7 text-slate-500">ميزات عامة يدير الأدمن إتاحتها على مستوى PowerHub. لا يوجد لها تحكم مستقل لكل صاحب مولد.</p></div>
            <Badge className="w-fit bg-sky-400/10 text-sky-300">تحكم على مستوى المنصة</Badge>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(features.data ?? []).filter((feature:any)=>feature.feature_type === "capability").map((feature:any) => (
              <div key={feature.feature_key} className="flex items-center justify-between gap-3 rounded-2xl border border-white/8 bg-white/[.018] p-4">
                <div className="min-w-0"><div className="flex items-center gap-2"><p className="font-bold text-white">{feature.name}</p><Badge className={feature.is_active ? "bg-emerald-400/10 text-emerald-300" : "bg-rose-400/10 text-rose-300"}>{feature.is_active ? "مفعلة" : "متوقفة"}</Badge></div><p className="mt-1 text-xs text-slate-500">{feature.description}</p></div>
                <Button size="sm" disabled={setGlobal.isPending} variant="outline" onClick={()=>setGlobal.mutate({featureKey:feature.feature_key,isActive:!feature.is_active})} className={feature.is_active ? "border-rose-400/30 text-rose-300 hover:bg-rose-400/10" : "border-emerald-400/30 text-emerald-300 hover:bg-emerald-400/10"}>{feature.is_active ? "إيقاف المنصة" : "تفعيل المنصة"}</Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel">
        <CardContent className="p-5">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div><h2 className="font-bold text-white">الميزات القابلة للتحكم لأصحاب المولدات</h2><p className="mt-1 text-sm leading-7 text-slate-500">يمكن إتاحة هذه الميزات أو إيقافها على مستوى المنصة، ثم يستمر التحكم الخاص بكل صاحب مولد في مصفوفة الميزات والحدود.</p></div>
            <Badge className="w-fit bg-[#F5B800]/10 text-[#F5B800]">تحكم مزدوج</Badge>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(features.data ?? []).filter((feature:any)=>feature.feature_type !== "capability").map((feature:any) => (
              <div key={feature.feature_key} className="flex items-center justify-between gap-3 rounded-2xl border border-[#F5B800]/15 bg-white/[.018] p-4">
                <div className="min-w-0"><div className="flex items-center gap-2"><p className="font-bold text-white">{feature.name}</p><Badge className={feature.is_active ? "bg-emerald-400/10 text-emerald-300" : "bg-rose-400/10 text-rose-300"}>{feature.is_active ? "مفعلة على المنصة" : "متوقفة على المنصة"}</Badge></div><p className="mt-1 text-xs text-slate-500">{feature.description}</p></div>
                <Button size="sm" disabled={setGlobal.isPending} variant="outline" onClick={()=>setGlobal.mutate({featureKey:feature.feature_key,isActive:!feature.is_active})} className={feature.is_active ? "border-rose-400/30 text-rose-300 hover:bg-rose-400/10" : "border-emerald-400/30 text-emerald-300 hover:bg-emerald-400/10"}>{feature.is_active ? "إيقاف المنصة" : "تفعيل المنصة"}</Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card className="border-white/8 bg-[#111823] shadow-panel">
        <CardContent className="p-0">
          <div className="overflow-x-auto"><table className="w-full min-w-[1000px] text-right text-sm">
            <thead className="border-b border-white/8 text-xs text-slate-500"><tr><th className="px-5 py-4">صاحب المولد</th><th className="px-4 py-4">الباقة</th><th className="px-4 py-4">الحالة</th><th className="px-4 py-4">المشتركون</th><th className="px-4 py-4">الفروع</th><th className="px-4 py-4">المستخدمون</th><th className="px-4 py-4">الإجراء</th></tr></thead>
            <tbody>{rows.map((row:any)=><tr key={row.tenant.id} className="border-t border-white/7 hover:bg-white/[.02]"><td className="px-5 py-4"><p className="font-bold text-white">{row.owner?.fullName ?? "غير محدد"}</p><p className="mt-1 text-xs text-slate-500">{row.tenant.name}</p></td><td className="px-4 py-4"><Badge className="bg-[#F5B800]/10 text-[#F5B800]">{row.subscription?.packageCode ?? "غير مهيأ"}</Badge></td><td className="px-4 py-4"><Badge className={["active","trial"].includes(row.subscription?.status) ? "bg-emerald-400/10 text-emerald-300" : "bg-slate-400/10 text-slate-400"}>{row.subscription?.status === "trial" ? "تجريبي" : row.subscription?.status === "active" ? "نشط" : row.subscription?.status ?? "غير مهيأ"}</Badge></td><td className="px-4 py-4 text-slate-300">{numberFormat(row.usage?.subscribers)}</td><td className="px-4 py-4 text-slate-300">{numberFormat(row.usage?.branches)}</td><td className="px-4 py-4 text-slate-300">{numberFormat((row.usage?.platformUsers ?? 0) + (row.usage?.fieldUsers ?? 0))}</td><td className="px-4 py-4"><Button size="sm" onClick={()=>navigate("/admin/generator-features/"+row.tenant.id)} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">إدارة الميزات</Button></td></tr>)}{!rows.length && <tr><td colSpan={7} className="py-12 text-center text-sm text-slate-500">{owners.isLoading ? "جارٍ تحميل أصحاب المولدات…" : "لا توجد نتائج."}</td></tr>}</tbody>
          </table></div>
        </CardContent>
      </Card>
    </main>
  </PlatformAdminLayout>;
}

const quotaAddonFeatures = new Set(["subscriber_management","platform_users","field_users","branch_management","sms"]);
const addonLabels: Record<string,string> = { subscribers50:"المشتركين", platformUser:"مستخدمو المنصة", fieldUser:"المستخدمون الميدانيون", branch:"الفروع", sms:"الرسائل" };

function FeatureRow({feature,policy,control,activeAddons,onGrant,onSave,pending}:{feature:any;policy:any;control:any;activeAddons:any[];onGrant:(v:any)=>void;onSave:(v:any)=>void;pending:boolean}) {
  const [status,setStatus]=useState(control?.status ?? "inherit");
  useEffect(() => { setStatus(control?.status ?? "inherit"); }, [control?.status]);
  const [billingMode,setBillingMode]=useState<"free"|"paid">("free");
  const [quantity,setQuantity]=useState(feature.feature_key === "subscriber_management" ? "100" : "1");
  const [note,setNote]=useState("");
  const effectiveEligible = policy?.policy === "included" || policy?.policy === "addon";
  const isQuota = feature.feature_type === "quota" && quotaAddonFeatures.has(feature.feature_key);
  const effectiveEnabled = isQuota ? effectiveEligible : status === "enabled" || (status === "inherit" && policy?.policy === "included");
  const addonCode = ({subscriber_management:"subscribers50",platform_users:"platformUser",field_users:"fieldUser",branch_management:"branch",sms:"sms"} as Record<string,string>)[feature.feature_key];
  const activeForFeature = activeAddons.filter((a:any)=>a.addonCode===addonCode);
  const addonDelta = activeForFeature.reduce((sum:number,a:any)=>sum + (feature.feature_key === "subscriber_management" ? Number(a.quantity)*50 : Number(a.quantity)),0);
  const baseLimit = policy?.defaultLimit == null ? null : Number(policy.defaultLimit);
  const effectiveLimit = isQuota && baseLimit != null ? baseLimit + addonDelta : baseLimit;
  const isSubscriber = feature.feature_key === "subscriber_management";
  const numericQuantity = Number(quantity);
  const validQuantity = Number.isInteger(numericQuantity) && numericQuantity > 0 && (!isSubscriber || numericQuantity % 50 === 0);
  return <div className="rounded-2xl border border-white/8 bg-white/[.018] p-4">
    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
      <div className="min-w-0 xl:w-[30%]"><div className="flex items-center gap-2"><p className="font-bold text-white">{feature.name}</p><Badge className={effectiveEnabled ? "bg-emerald-400/10 text-emerald-300" : "bg-slate-400/10 text-slate-400"}>{effectiveEnabled ? "فعّالة" : "غير فعّالة"}</Badge></div><p className="mt-1 text-xs leading-6 text-slate-500">{feature.description}</p><div className="mt-2 flex flex-wrap gap-2 text-[11px]"><Badge className="bg-white/5 text-slate-400">{categoryLabels[feature.category] ?? feature.category}</Badge><Badge className={policy?.policy === "addon" ? "bg-amber-400/10 text-amber-300" : policy?.policy === "included" ? "bg-sky-400/10 text-sky-300" : "bg-rose-400/10 text-rose-300"}>{policyLabel(policy?.policy)}</Badge>{isQuota && effectiveLimit != null && <Badge className="bg-[#F5B800]/10 text-[#F5B800]">الحد الفعلي: {numberFormat(effectiveLimit)}</Badge>}</div></div>
      {isQuota ? <div className="flex-1 rounded-2xl border border-[#F5B800]/15 bg-[#F5B800]/[.035] p-4"><div className="flex flex-col gap-3 lg:flex-row lg:items-end"><label className="text-xs text-slate-500">كمية الإضافة{isSubscriber ? " (بمضاعفات 50)" : ""}<Input value={quantity} onChange={e=>setQuantity(e.target.value.replace(/\\D/g,""))} inputMode="numeric" className="mt-1 w-full lg:w-36" dir="ltr"/></label><label className="text-xs text-slate-500">نوع الإضافة<select value={billingMode} onChange={e=>setBillingMode(e.target.value as "free"|"paid")} className={inputClass+" mt-1"}><option value="free">مجانية / منحة</option><option value="paid">مدفوعة</option></select></label><label className="flex-1 text-xs text-slate-500">ملاحظة<Input value={note} onChange={e=>setNote(e.target.value)} maxLength={2000} placeholder="اختياري" className="mt-1"/></label><Button size="sm" disabled={pending || !effectiveEligible || !validQuantity} onClick={()=>onGrant({featureKey:feature.feature_key,quantity:numericQuantity,billingMode,note})} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><Plus className="ml-1 h-4 w-4"/>إضافة سعة</Button></div><p className="mt-3 text-xs text-slate-400">الأساسي: {baseLimit == null ? "—" : numberFormat(baseLimit)} · الإضافات الحالية: +{numberFormat(addonDelta)} · الفعلي: {effectiveLimit == null ? "—" : numberFormat(effectiveLimit)} · تنتهي الإضافة مع نهاية الاشتراك.</p>{activeForFeature.length > 0 && <div className="mt-3 space-y-2">{activeForFeature.map((a:any)=><div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/8 bg-black/10 px-3 py-2 text-xs"><span className="font-bold text-slate-200">+{numberFormat(isSubscriber ? Number(a.quantity)*50 : a.quantity)} {addonLabels[a.addonCode] ?? a.addonCode}</span><span className="text-slate-500">{a.billingMode === "paid" ? "مدفوعة" : "مجانية"} · حتى {a.endsAt ? new Intl.DateTimeFormat("ar-PS",{dateStyle:"medium"}).format(new Date(a.endsAt)) : "نهاية الاشتراك"}</span></div>)}</div>}</div> : <div className="grid flex-1 gap-3 md:grid-cols-[minmax(0,220px)_1fr_auto] items-end"><label className="text-xs text-slate-500">الحالة<select value={status} onChange={e=>setStatus(e.target.value)} className={inputClass+" mt-1"}><option value="inherit">حسب الباقة</option><option value="enabled" disabled={!effectiveEligible || feature.is_active === false}>تفعيل</option><option value="disabled">تعطيل</option></select></label><label className="text-xs text-slate-500">ملاحظة<Input value={note} onChange={e=>setNote(e.target.value)} maxLength={2000} placeholder="اختياري" className="mt-1"/></label><Button size="sm" disabled={pending || status === (control?.status ?? "inherit")} onClick={()=>onSave({status,limitMode:"inherit",manualLimit:null,reason:note})} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">حفظ الحالة</Button></div>}
    </div>
  </div>;
}

function FeatureControlsDetail({tenantId}:{tenantId:number}) {
  const [,navigate]=useLocation();
  const featureAdmin = trpc.admin as any;
  const snapshot=featureAdmin.tenantFeatureSnapshot.useQuery({tenantId});
  const features=featureAdmin.featureCatalog.useQuery();
  const utils=trpc.useUtils();
  const save=featureAdmin.setTenantFeatureControl.useMutation({onSuccess:()=>{void (utils.admin as any).tenantFeatureSnapshot.invalidate({tenantId});toast.success("تم حفظ حالة الميزة.");},onError:(e:Error)=>toast.error(e.message)});
  const grant=featureAdmin.grantTenantAddon.useMutation({onSuccess:()=>{void (utils.admin as any).tenantFeatureSnapshot.invalidate({tenantId});toast.success("تمت إضافة السعة وربطها بنهاية الاشتراك.");},onError:(e:Error)=>toast.error(e.message)});
  const policyByKey=new Map((snapshot.data?.packagePolicies ?? []).map((p:any)=>[p.featureKey,p]));
  const activeAddons=snapshot.data?.activeAddons ?? [];
  const controlByKey=new Map((snapshot.data?.controls ?? []).map((c:any)=>[c.featureKey,c]));
  const groups=useMemo<[string, any[]][]>(()=>{const all=features.data ?? [];return Object.entries(all.reduce((acc:any,f:any)=>{(acc[f.category]??=[]).push(f);return acc;},{} as Record<string,any[]>)) as [string, any[]][];},[features.data]);
  const tenant=snapshot.data?.tenant;
  const grantAddon=(value:any)=>grant.mutate({...value,tenantId,requestKey:crypto.randomUUID()});
  return <PlatformAdminLayout activeTab="features" onTabChange={tab=>{if(tab === "features") {navigate("/admin/generator-features"); return;} navigate("/admin");}}>
    <main className="space-y-6 pb-12">
      <div className="flex items-center gap-3"><Button variant="outline" onClick={()=>navigate("/admin/generator-features")} className="border-white/10 text-white hover:bg-white/5 hover:text-white"><ArrowRight className="ml-1 h-4 w-4"/>أصحاب المولدات</Button><div><p className="text-xs font-bold text-[#F5B800]">الميزات والحدود</p><h1 className="text-2xl font-extrabold text-white">{snapshot.data?.owner?.fullName ?? tenant?.name ?? "تفاصيل صاحب المولد"}</h1><p className="mt-1 text-sm text-slate-500">{tenant?.name ?? "—"} · الباقة {snapshot.data?.subscription?.packageCode ?? "—"}</p></div></div>
      <div className="grid gap-4 md:grid-cols-4"><Card className="border-white/8 bg-[#111823]"><CardContent className="p-4"><UsersRound className="h-5 w-5 text-[#F5B800]"/><p className="mt-3 text-xs text-slate-500">المشتركون</p><p className="mt-1 text-2xl font-extrabold text-white">{numberFormat(snapshot.data?.usage.subscribers)}</p></CardContent></Card><Card className="border-white/8 bg-[#111823]"><CardContent className="p-4"><Zap className="h-5 w-5 text-[#F5B800]"/><p className="mt-3 text-xs text-slate-500">الفروع</p><p className="mt-1 text-2xl font-extrabold text-white">{numberFormat(snapshot.data?.usage.branches)}</p></CardContent></Card><Card className="border-white/8 bg-[#111823]"><CardContent className="p-4"><UsersRound className="h-5 w-5 text-[#F5B800]"/><p className="mt-3 text-xs text-slate-500">مستخدمو المنصة</p><p className="mt-1 text-2xl font-extrabold text-white">{numberFormat(snapshot.data?.usage.platformUsers)}</p></CardContent></Card><Card className="border-white/8 bg-[#111823]"><CardContent className="p-4"><Zap className="h-5 w-5 text-[#F5B800]"/><p className="mt-3 text-xs text-slate-500">المستخدمون الميدانيون</p><p className="mt-1 text-2xl font-extrabold text-white">{numberFormat(snapshot.data?.usage.fieldUsers)}</p></CardContent></Card></div>
      <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="mb-5"><h2 className="font-bold text-white">مصفوفة الميزات والتحكم</h2><p className="mt-1 text-sm leading-7 text-slate-500">لا يتغير إعداد الباقة نفسه. التعديل هنا استثناء لهذا صاحب المولد فقط.</p></div><div className="space-y-4">{groups.map(([category,list])=><section key={category}><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-extrabold text-[#F5B800]">{category}</h3><span className="text-xs text-slate-600">{list.length} ميزات</span></div><div className="space-y-3">{list.map((feature:any)=><FeatureRow key={feature.feature_key} feature={feature} policy={policyByKey.get(feature.feature_key)} control={controlByKey.get(feature.feature_key)} activeAddons={activeAddons} pending={save.isPending||grant.isPending} onGrant={grantAddon} onSave={(v)=>save.mutate({tenantId,featureKey:feature.feature_key,...v})}/>)}</div></section>)}</div></CardContent></Card>
    </main>
  </PlatformAdminLayout>;
}

export default function AdminGeneratorFeaturesPage() {
  const [match,params]=useRoute("/admin/generator-features/:tenantId");
  if(match && params?.tenantId) return <FeatureControlsDetail tenantId={Number(params.tenantId)}/>;
  return <FeatureControlsIndex/>;
}
