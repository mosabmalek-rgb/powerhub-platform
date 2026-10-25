import DashboardLayout from "@/components/DashboardLayout";
import { MetricCard } from "@/components/MetricCard";
import { SubscriberQuotaDashboardCard } from "@/components/SubscriberQuotaDashboardCard";
import { SubscriptionRenewalDashboardCard } from "@/components/SubscriptionRenewalDashboardCard";
import { OperationalStatusDashboardCard } from "@/components/OperationalStatusDashboardCard";
import { FinancialTrendSection } from "@/components/FinancialTrendSection";
import { PowerHubLogo } from "@/components/PowerHubLogo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/_core/hooks/useAuth";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { useDashboardKpiPeriod } from "@/hooks/useDashboardKpiPeriod";
import { DashboardKpiPeriodFilter } from "@/components/DashboardKpiPeriodFilter";
import { trpc } from "@/lib/trpc";
import { authenticatedHomePath } from "@/lib/role-routing";
import { useLocation } from "wouter";
import {
  ArrowUpLeft, BellRing, CalendarDays, ChevronLeft, CircleAlert,
  CircleDollarSign, Clock3, FilePlus2, FileText, MessageSquareText, ReceiptText,
  UsersRound, WalletCards, Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import MarketingLandingPage from "./MarketingLandingPage";

const number = (value: unknown, fractionDigits = 0) => new Intl.NumberFormat("ar", { maximumFractionDigits: fractionDigits }).format(Number(value ?? 0));
const ratio = (value: unknown) => `${number(value, 1)}%`;


function QuotaLoadErrorCard({ labels, onRetry }: { labels: string[]; onRetry: () => unknown }) {
  return <Card role="alert" className="border-rose-400/25 bg-[#111823] shadow-panel"><CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-bold text-rose-200">تعذر تحميل بيانات بعض الحصص</h2><p className="mt-1 text-sm leading-6 text-slate-300">تعذر تحميل: {labels.join("، ")}. لم نفترض أن أي حصة صفر أو أنها مستنفدة.</p></div><Button type="button" variant="outline" onClick={() => { void onRetry(); }} className="border-white/15 text-white hover:bg-white/5 hover:text-white">إعادة المحاولة</Button></CardContent></Card>;
}

function SmsQuotaDashboardCard({quota,loading,packages=[],packageRequest,packageRequestLoading=false,packageRequestError=false,requestingPackage=false,onRetryPackageRequest,onRequestPackage,onOpen}:{
 quota:any;loading:boolean;packages?:any[];packageRequest?:any;packageRequestLoading?:boolean;packageRequestError?:boolean;requestingPackage?:boolean;
 onRetryPackageRequest?:()=>unknown;onRequestPackage?:(packageId:number,note?:string)=>void;onOpen:()=>void;
}) {
 const [selectedPackageId,setSelectedPackageId]=useState("");
 if(loading)return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="h-40 animate-pulse p-5"><div className="h-4 w-48 rounded bg-white/10"/><div className="mt-6 h-9 w-28 rounded bg-white/10"/><div className="mt-5 h-2 w-full rounded bg-white/5"/></CardContent></Card>;
 const total=Number(quota?.total??0),used=Number(quota?.used??0),remaining=Number(quota?.remaining??0);
 const providerLimit=Number(quota?.providerMonthlyLimit??0),providerUsed=Number(quota?.providerMonthlyUsed??0);
 const percent=total>0?Math.min(100,used/total*100):0;
 const unavailable=!quota?.configured||!quota?.isActive,exhausted=total>0&&remaining<=0,warning=unavailable||exhausted||percent>=80;
 const pending=["pending","reviewing"].includes(String(packageRequest?.status??""))||packageRequest?.ledgerStatus==="pending";
 const tone=warning?exhausted||unavailable?"text-rose-300":"text-amber-200":"text-emerald-300";
 const state=!quota?.configured?"حساب TweetSMS غير مهيأ":!quota?.isActive?"الإرسال غير مفعل":total<=0?"لا يوجد رصيد مشحون":exhausted?"الرصيد مستنفد":percent>=80?"الرصيد يقترب من النفاد":"رصيد الرسائل متاح";
 const selectedId=selectedPackageId||String(packages[0]?.id??"");
 const price=(pkg:any)=>Number(pkg?.price??0)>0?`${number(pkg.price,2)} ${pkg.currency==="ILS"?"₪":pkg.currency}`:"السعر يحدده الإدارة";
 return <Card className={`${warning?"border-amber-300/25":"border-emerald-400/20"} bg-[#111823] shadow-panel`}><CardContent className="p-5 sm:p-6">
  <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between"><div className="flex min-w-0 items-start gap-3"><span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/[.04] ${tone}`}><MessageSquareText className="h-5 w-5"/></span><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-bold text-white">محفظة رسائل SMS</h2><Badge className={warning?"bg-amber-300/10 text-amber-200":"bg-emerald-400/10 text-emerald-300"}>{state}</Badge></div><p className="mt-1 text-sm leading-6 text-slate-400">رصيد مدفوع دائم لا تنتهي صلاحيته ولا يتجدد شهرياً. يُحتسب الاستهلاك بمقاطع الرسائل.</p><p className="mt-2 text-xs text-slate-500">المرسل: <strong className="font-bold text-slate-300" dir="ltr">{quota?.senderName||"غير مهيأ"}</strong></p></div></div>
   <div className="grid grid-cols-3 gap-3 text-center sm:min-w-[330px]"><div className="rounded-xl border border-white/8 bg-white/[.02] px-3 py-3"><p className="text-[11px] text-slate-500">المتبقي</p><p className="mt-1 font-display text-2xl font-extrabold text-white">{number(remaining)}</p></div><div className="rounded-xl border border-white/8 bg-white/[.02] px-3 py-3"><p className="text-[11px] text-slate-500">المستهلك (مقاطع)</p><p className="mt-1 font-display text-2xl font-extrabold text-slate-200">{number(used)}</p></div><div className="rounded-xl border border-white/8 bg-white/[.02] px-3 py-3"><p className="text-[11px] text-slate-500">إجمالي المشحون</p><p className="mt-1 font-display text-2xl font-extrabold text-[#F5B800]">{number(total)}</p></div></div></div>
  <div className="mt-5"><div className="flex items-center justify-between text-xs"><span className="text-slate-500">استهلاك المحفظة الدائمة</span><span className="font-bold text-slate-300">{number(percent)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-black/30"><div className={`h-full rounded-full ${exhausted?"bg-rose-400":percent>=80?"bg-amber-300":"bg-emerald-400"}`} style={{width:`${percent}%`}}/></div></div>
  <div className="mt-4 rounded-xl border border-sky-300/15 bg-sky-300/[.035] p-4"><p className="font-bold text-white">حد مزود الرسائل الشهري</p><p className="mt-1 text-xs leading-5 text-slate-400">هذا الحد منفصل عن الرصيد المدفوع ولا يغيّر مدة صلاحية المحفظة.</p><p className="mt-2 text-sm font-bold text-sky-200">{providerLimit>0?`${number(providerUsed)} مستخدم من ${number(providerLimit)} مقطع، والمتبقي ${number(Math.max(0,providerLimit-providerUsed))}`:"لا يوجد حد شهري رقمي مضبوط لدى المزود."}</p></div>
  <div className="mt-4 rounded-xl border border-white/8 bg-white/[.018] p-4"><h3 className="font-bold text-white">شراء حزمة رسائل مستقلة</h3><p className="mt-1 text-xs leading-5 text-slate-400">اختر حزمة محددة من إدارة المنصة. لا يضاف الرصيد إلا بعد مراجعة الطلب وشحنه.</p>
   {packageRequestError?<div className="mt-3 flex items-center justify-between gap-3"><p className="text-sm text-rose-200">تعذر التحقق من الطلب السابق؛ أعد المحاولة قبل طلب جديد.</p><Button type="button" variant="outline" onClick={()=>{void onRetryPackageRequest?.();}}>إعادة المحاولة</Button></div>:packageRequestLoading?<p className="mt-3 text-sm text-slate-400">جارٍ التحقق من حالة الطلب…</p>:pending?<p className="mt-3 rounded-lg border border-amber-300/20 bg-amber-300/[.04] p-3 text-sm font-bold text-amber-200">لديك طلب بانتظار المراجعة: {number(packageRequest?.requestedMessages)} رسالة. لن يتاح طلب آخر حتى حسمه.</p>:packageRequest?.status==="approved"?<p className="mt-3 text-sm font-bold text-emerald-300">تم اعتماد الطلب؛ راجع إجمالي الرصيد المشحون أعلاه.</p>:packageRequest?.status==="rejected"?<p className="mt-3 text-sm font-bold text-rose-300">رُفض آخر طلب؛ يمكنك اختيار حزمة أخرى.</p>:packageRequest?.status==="cancelled"?<p className="mt-3 text-sm text-slate-400">أُلغي آخر طلب؛ يمكنك اختيار حزمة أخرى.</p>:null}
   <div className="mt-3 flex flex-col gap-2 sm:flex-row"><select aria-label="حزمة رصيد SMS" value={selectedId} onChange={e=>setSelectedPackageId(e.target.value)} disabled={!packages.length||pending||packageRequestLoading||packageRequestError||requestingPackage} className="h-10 min-w-0 flex-1 rounded-xl border border-white/15 bg-[#0D1117] px-3 text-sm text-white disabled:opacity-50">{!packages.length&&<option value="">لا توجد حزم مفعلة حالياً</option>}{packages.map((pkg:any)=><option key={pkg.id} value={String(pkg.id)}>{pkg.name} — {number(pkg.messages)} رسالة — {price(pkg)}</option>)}</select><Button type="button" disabled={!packages.length||!selectedId||pending||packageRequestLoading||packageRequestError||requestingPackage} onClick={()=>onRequestPackage?.(Number(selectedId))} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">{requestingPackage?"جارٍ إرسال الطلب…":"طلب هذه الحزمة"}</Button></div>
  </div>
  <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p className={`text-xs ${tone}`}>{quota?.lastError||(unavailable?"راجع إدارة PowerHub لتفعيل الإرسال.":"المحفظة وحد مزود الخدمة معروضان بشكل منفصل.")}</p><button type="button" onClick={onOpen} className="text-sm font-bold text-[#F5B800] hover:text-[#ffd23f]">تفاصيل الرسائل والإشعارات <ChevronLeft className="mr-1 inline h-4 w-4"/></button></div>
 </CardContent></Card>;
}

function BranchQuotaDashboardCard({ policy, loading, onOpen }: { policy: any; loading: boolean; onOpen: () => void }) { if (loading) return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="h-32 animate-pulse p-5" /></Card>; const limit = Number(policy?.maxBranches ?? 1); const current = Number(policy?.currentCount ?? 0); const remaining = Number(policy?.remaining ?? 0); const percent = limit ? Math.min(100, Math.round(current / limit * 100)) : 100; const exhausted = remaining <= 0; const warning = exhausted || percent >= 80; const tone = exhausted ? "rose" : warning ? "amber" : "sky"; return <Card className={`${warning ? "border-amber-400/25" : "border-sky-400/20"} bg-[#111823] shadow-panel`}><CardContent className="p-5"><div className="flex items-start justify-between gap-4"><div><p className="font-bold text-white">استهلاك حصة الأفرع</p><p className="mt-1 text-sm text-slate-400">{policy?.isEnabled ? exhausted ? "بلغت الحد الأقصى للأفرع المتاحة." : `يمكنك إنشاء ${number(remaining)} فرع إضافي.` : "ميزة الأفرع الإضافية غير مفعلة في باقتك."}</p></div><Badge className={tone === "rose" ? "bg-rose-400/10 text-rose-300" : tone === "amber" ? "bg-amber-400/10 text-amber-200" : "bg-sky-400/10 text-sky-300"}>{percent}%</Badge></div><div className="mt-4"><div className="flex justify-between text-xs text-slate-500"><span>{number(current)} من {number(limit)} فرع</span><button type="button" onClick={onOpen} className="font-bold text-[#F5B800] hover:underline">إدارة الأفرع</button></div><div role="progressbar" aria-label="استهلاك حصة الأفرع" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} className="mt-2 h-2 overflow-hidden rounded-full bg-black/30"><div className={`${tone === "rose" ? "bg-rose-400" : tone === "amber" ? "bg-amber-300" : "bg-sky-400"} h-full rounded-full transition-[width] duration-300`} style={{ width: `${percent}%` }} /></div></div></CardContent></Card>; }

function TeamQuotaDashboardCard({ subaccountQuota, loading }: { subaccountQuota: any; loading: boolean }) {
  if (loading) return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="h-32 animate-pulse p-5" /></Card>;
  const items = [
    { label: "الحسابات الفرعية", limit: Number(subaccountQuota?.limit ?? 0), used: Number(subaccountQuota?.currentCount ?? 0) },
    { label: "مستخدمو التطبيق الميداني", limit: Number(subaccountQuota?.fieldUserLimit ?? 0), used: Number(subaccountQuota?.fieldUserCount ?? 0) },
  ];
  return <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-5 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-bold text-white">حدود حسابات الفريق والميدان</h2><p className="mt-1 text-sm text-slate-400">يعرض هذا الملخص حدود الحسابات الفرعية والمستخدمين الميدانيين فقط؛ تفاصيل المشتركين والأفرع وSMS موجودة في بطاقاتها المخصصة.</p></div><Badge className="bg-[#F5B800]/10 text-[#F5B800]">حدّان</Badge></div>
    <div className="mt-5 grid gap-3 sm:grid-cols-2">{items.map((item) => { const pct = item.limit > 0 ? Math.min(100, Math.round(item.used / item.limit * 100)) : 0; return <div key={item.label} className="rounded-2xl border border-white/8 bg-white/[.018] p-4"><p className="text-xs text-slate-500">{item.label}</p><p className="mt-2 text-lg font-extrabold text-white">{number(item.limit)}</p><p className="mt-1 text-xs text-slate-400">المستخدم: <span className="font-bold text-slate-200">{number(item.used)}</span></p><div className="mt-3 h-2 overflow-hidden rounded-full bg-black/30"><div className={pct >= 100 ? "h-full rounded-full bg-rose-400" : pct >= 80 ? "h-full rounded-full bg-amber-300" : "h-full rounded-full bg-emerald-400"} style={{ width: `${pct}%` }} /></div><p className="mt-2 text-xs font-bold text-slate-300">{pct}% مستخدم · المتبقي {number(Math.max(0, item.limit - item.used))}</p></div>; })}</div>
  </CardContent></Card>;
}

function StateLine({ label, value, hint, tone = "bg-[#F5B800]" }: { label: string; value: string; hint: string; tone?: string }) {
  return <div className="flex items-center justify-between gap-4 px-5 py-4"><div className="flex min-w-0 items-center gap-3"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${tone}`} /><div><p className="font-bold text-white">{label}</p><p className="mt-1 text-xs leading-5 text-slate-500">{hint}</p></div></div><span className="shrink-0 font-display text-xl font-extrabold text-white">{value}</span></div>;
}

function CompanyBalancesDashboardCard({ accounts, loading, error = false, onOpen, onRetry }: { accounts: any[]; loading: boolean; error?: boolean; onOpen: () => void; onRetry?: () => unknown }) {
  if (loading) return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="h-40 animate-pulse p-5"><div className="h-4 w-52 rounded bg-white/10" /><div className="mt-6 h-9 w-44 rounded bg-white/10" /></CardContent></Card>;
  if (error) return <Card role="alert" className="border-rose-400/25 bg-[#111823] shadow-panel"><CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-bold text-rose-200">تعذر تحميل أرصدة حسابات الشركة</h2><p className="mt-1 text-sm text-slate-300">لم نعرض الرصيد على أنه صفر؛ تحقق من الاتصال ثم أعد المحاولة.</p></div><Button type="button" variant="outline" onClick={() => { void onRetry?.(); }} className="border-white/15 text-white hover:bg-white/5 hover:text-white">إعادة المحاولة</Button></CardContent></Card>;
  const total = accounts.reduce((sum, account) => sum + Number(account.balance ?? 0), 0);
  const byType = accounts.reduce<Record<string, number>>((summary, account) => { summary[account.accountType] = (summary[account.accountType] ?? 0) + Number(account.balance ?? 0); return summary; }, {});
  const types = [{ key: "cash", label: "كاش", tone: "text-slate-200" }, { key: "jawwal_pay", label: "جوال بي", tone: "text-lime-200" }, { key: "palpay", label: "بال بي", tone: "text-fuchsia-200" }, { key: "bank_of_palestine", label: "بنك فلسطين", tone: "text-rose-200" }].filter((type) => byType[type.key] !== undefined);
  return <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-5 sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><WalletCards className="h-4 w-4" />ملخص حسابات الشركة</div><p className="mt-2 text-sm text-slate-400">الأرصدة الحالية عبر كل الحسابات المتاحة في مساحة الشركة.</p></div><Button variant="outline" onClick={onOpen} className="border-[#F5B800]/30 text-[#F5B800] hover:bg-[#F5B800]/10">فتح الحسابات</Button></div><div className="mt-5 flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs text-slate-500">إجمالي السيولة المتاحة</p><p className="mt-1 font-display text-3xl font-extrabold text-white">{number(total, 2)} <span className="text-sm text-[#F5B800]">ش</span></p></div><div className="grid min-w-[290px] flex-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">{types.length ? types.map((type) => <div key={type.key} className="rounded-xl border border-white/8 bg-white/[.018] px-3 py-3"><p className="text-[11px] text-slate-500">{type.label}</p><p className={`mt-1 font-bold ${type.tone}`}>{number(byType[type.key], 2)} ش</p></div>) : <p className="rounded-xl border border-dashed border-white/10 px-3 py-4 text-center text-xs text-slate-500">لا توجد حسابات شركة مضافة بعد.</p>}</div></div></CardContent></Card>;
}

export function WorkspaceHome() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, loading, user } = useAuth();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated && !user?.mustChangePassword });
  const { branchId: siteId, setBranchId: setSiteId } = useBranchFilter(sitesQuery.data);
  const [scope, setScope] = useState<"branch" | "all">("branch");
  const summaryQuery = trpc.powerhub.dashboard.summary.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && !user?.mustChangePassword) });
  const subscriberQuotaQuery = trpc.powerhub.subscribers.quota.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && !user?.mustChangePassword) });
  const packageCatalogQuery = trpc.powerhub.publicPackageCatalog.useQuery(undefined, { staleTime: 60_000 });
  const packageCodes = (packageCatalogQuery.data?.packages ?? []).filter((pkg: any) => pkg.active !== false).map((pkg: any) => String(pkg.code));
  const accessQuery = trpc.powerhub.staff.myAccess.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && !user?.mustChangePassword) });
  const smsQuotaQuery = trpc.powerhub.messaging.smsQuota.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && accessQuery.data?.role === "owner" && !user?.mustChangePassword) });
  const smsCreditPackagesQuery = trpc.powerhub.messaging.smsCreditPackages.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && accessQuery.data?.role === "owner" && !user?.mustChangePassword), staleTime: 60_000 });
  const branchPolicyQuery = trpc.powerhub.sites.branchPolicy.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && accessQuery.data?.role === "owner" && !user?.mustChangePassword) });
  const subaccountQuotaQuery = trpc.powerhub.staff.allowedSubaccountRoles.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && accessQuery.data?.role === "owner" && !user?.mustChangePassword) });
  const smsPackageRequestQuery = trpc.powerhub.messaging.currentSmsPackageRequest.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && accessQuery.data?.role === "owner" && !user?.mustChangePassword), refetchInterval: 15000 });
  const requestSmsPackage = trpc.powerhub.messaging.requestSmsPackage.useMutation({ onSuccess: async () => { await Promise.all([smsPackageRequestQuery.refetch(), smsQuotaQuery.refetch()]); toast.success("تم إرسال طلب الحزمة للمراجعة."); }, onError: (error) => toast.error(error.message) });
  // Most owners have a single branch; skip the cross-branch permission query unless it can affect the UI.
  const allBranchAccessQuery = trpc.powerhub.staff.allBranchAccess.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && (sitesQuery.data?.length ?? 0) > 1 && !user?.mustChangePassword) });
  const upgradeRequestQuery = trpc.powerhub.subscription.currentUpgradeRequest.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && !user?.mustChangePassword) });
  const ownerRenewalQuery = trpc.powerhub.subscription.ownerRenewalStatus.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && !user?.mustChangePassword), refetchInterval: 5 * 60 * 1000 });
  const addonRequestsQuery = trpc.powerhub.subscription.currentAddonRequests.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && accessQuery.data?.role === "owner" && !user?.mustChangePassword) });

  const quotaQueries = [
    { label: "المشتركون", query: subscriberQuotaQuery },
    { label: "رصيد SMS", query: smsQuotaQuery },
    { label: "الأفرع", query: branchPolicyQuery },
    { label: "الحسابات الفرعية والميدانية", query: subaccountQuotaQuery },
  ] as const;
  const failedQuotaLabels = quotaQueries.filter(({ query }) => query.isError).map(({ label }) => label);
  const retryFailedQuotaQueries = async () => {
    await Promise.all(quotaQueries.filter(({ query }) => query.isError).map(({ query }) => query.refetch()));
  };

  const canUseAllBranches = Boolean(allBranchAccessQuery.data?.isGlobal && (sitesQuery.data?.length ?? 0) > 1);
  const selectedScope = scope === "all" && canUseAllBranches ? "all" : "branch";
  const dashboardPeriod = useDashboardKpiPeriod(siteId);
  const allBranchesSummaryQuery = trpc.powerhub.dashboard.allBranchesSummary.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && selectedScope === "all" && !user?.mustChangePassword) });
  const financialOverviewQuery = trpc.powerhub.dashboard.financialOverview.useQuery({ siteId: siteId ?? 0, scope: selectedScope }, { enabled: Boolean(isAuthenticated && siteId && !user?.mustChangePassword), staleTime: 20_000 });
  const periodMetricsQuery = trpc.powerhub.dashboard.periodMetrics.useQuery({
    siteId: siteId ?? 0,
    scope: selectedScope,
    startDate: dashboardPeriod.startDate,
    endDate: dashboardPeriod.endDate,
    includeDetails: false,
  }, {
    enabled: Boolean(isAuthenticated && siteId && !user?.mustChangePassword && dashboardPeriod.isReady),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const companyAccountsQuery = trpc.powerhub.companyAccounts.list.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(isAuthenticated && siteId && !user?.mustChangePassword) });
  const requestUpgrade = trpc.powerhub.subscription.requestUpgrade.useMutation({ onSuccess: (result) => { void upgradeRequestQuery.refetch(); toast.success(result.alreadyRequested ? "لديك طلب ترقية قيد المتابعة بالفعل." : `تم إرسال طلب الترقية إلى باقة ${result.requestedPackageCode}.`); }, onError: (error) => toast.error(error.message) });
  const requestAddon = trpc.powerhub.subscription.requestAddon.useMutation({ onSuccess: async (result) => { await addonRequestsQuery.refetch(); toast.success(result.alreadyRequested ? "لديك طلب إضافة قيد المتابعة بالفعل." : "تم إرسال طلب الإضافة إلى إدارة PowerHub."); }, onError: (error) => toast.error(error.message) });
  const overview = financialOverviewQuery.data;
  const dashboardDataError = sitesQuery.isError || accessQuery.isError || financialOverviewQuery.isError ||
    (selectedScope === "all" ? allBranchesSummaryQuery.isError : summaryQuery.isError);
  const dashboardDataFailures: string[] = [];
  if (sitesQuery.isError) dashboardDataFailures.push(`الفروع: ${sitesQuery.error?.message ?? "تعذر تحديد السبب"}`);
  if (accessQuery.isError) dashboardDataFailures.push(`صلاحيات الفرع: ${accessQuery.error?.message ?? "تعذر تحديد السبب"}`);
  if (financialOverviewQuery.isError) dashboardDataFailures.push(`الملخص المالي: ${financialOverviewQuery.error?.message ?? "تعذر تحديد السبب"}`);
  if (selectedScope === "all" && allBranchesSummaryQuery.isError) dashboardDataFailures.push(`ملخص جميع الفروع: ${allBranchesSummaryQuery.error?.message ?? "تعذر تحديد السبب"}`);
  if (selectedScope !== "all" && summaryQuery.isError) dashboardDataFailures.push(`مؤشرات الفرع: ${summaryQuery.error?.message ?? "تعذر تحديد السبب"}`);
  const retryDashboardData = () => {
    void sitesQuery.refetch();
    void accessQuery.refetch();
    void financialOverviewQuery.refetch();
    dashboardPeriod.retry();
    void periodMetricsQuery.refetch();
    if (selectedScope === "all") void allBranchesSummaryQuery.refetch();
    else void summaryQuery.refetch();
  };
  const metricNumber = (value: unknown, fractionDigits = 0) => financialOverviewQuery.isError
    ? "—"
    : financialOverviewQuery.isLoading ? "…" : number(value, fractionDigits);
  const metricRatio = (value: unknown) => financialOverviewQuery.isError
    ? "—"
    : financialOverviewQuery.isLoading ? "…" : ratio(value);
  const periodMetricsMatch = Boolean(
    periodMetricsQuery.data &&
    periodMetricsQuery.data.range.startDate === dashboardPeriod.startDate &&
    periodMetricsQuery.data.range.endDate === dashboardPeriod.endDate &&
    periodMetricsQuery.data.scope === selectedScope
  );
  const periodMetricsLoading = dashboardPeriod.isLoading || !dashboardPeriod.isReady || periodMetricsQuery.isLoading || !periodMetricsMatch;
  const periodMetricNumber = (value: unknown, fractionDigits = 2) => dashboardPeriod.isError || periodMetricsQuery.isError
    ? "—"
    : periodMetricsLoading ? "…" : number(value, fractionDigits);
  const periodMetricRatio = (value: unknown) => dashboardPeriod.isError || periodMetricsQuery.isError
    ? "—"
    : periodMetricsLoading ? "…" : ratio(value);
  const openPeriodArrears = () => {
    if (!siteId || !dashboardPeriod.isReady || !dashboardPeriod.startDate || !dashboardPeriod.endDate) return;
    const params = new URLSearchParams({
      siteId: String(siteId),
      debtorScope: selectedScope,
      debtorPeriod: dashboardPeriod.preset,
      startDate: dashboardPeriod.startDate,
      endDate: dashboardPeriod.endDate,
      debtorStatus: "overdue",
      debtorFocus: "1",
    });
    setLocation(`/subscribers?${params.toString()}#subscriber-arrears`);
  };
  const activeSubscribers = overview?.branchSummaries.reduce((sum, branch) => sum + branch.activeSubscribers, 0) ?? 0;
  const operationalSummary = selectedScope === "all" ? allBranchesSummaryQuery.data : summaryQuery.data;

  useEffect(() => {
    if (!loading && !isAuthenticated) { setLocation("/login"); return; }
    if (!loading && isAuthenticated && user?.mustChangePassword) { setLocation("/profile"); return; }
    if (!loading && isAuthenticated && user?.role === "admin") window.location.assign(authenticatedHomePath(user));
  }, [isAuthenticated, loading, setLocation, user]);

  useEffect(() => { if (scope === "all" && !canUseAllBranches) setScope("branch"); }, [canUseAllBranches, scope]);


  if (loading) return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">جارٍ التحقق من جلسة الدخول…</h1><p className="mt-2 text-sm text-slate-400">لن نعيد توجيهك قبل اكتمال التحقق.</p></div></main>;
  if (!isAuthenticated) return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">جارٍ توجيهك إلى تسجيل الدخول…</h1></div></main>;
  if (user?.mustChangePassword || user?.role === "admin") return <main className="grid min-h-screen place-items-center bg-[#0D1117] px-5 text-center" dir="rtl"><div><p className="text-sm font-bold text-[#F5B800]">PowerHub</p><h1 className="mt-3 text-xl font-extrabold text-white">جارٍ فتح المساحة المصرح بها…</h1></div></main>;

  return <DashboardLayout><div className="space-y-6 pb-12">
    <header className="flex flex-col gap-5 rounded-[24px] border border-white/8 bg-[#111823]/75 p-5 shadow-panel backdrop-blur sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div className="flex items-start gap-4"><div className="mt-0.5 lg:hidden"><PowerHubLogo compact /></div><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Zap className="h-4 w-4 fill-current" />مركز الأداء المالي</div><h1 className="mt-1 text-2xl font-extrabold tracking-tight text-white sm:text-3xl">الفوترة والتحصيل تحت السيطرة</h1><p className="mt-2 text-sm text-slate-400">تابع المستحقات والتحصيل والمتأخرات وحالة الفروع من شاشة واحدة.</p></div></div>
      <div className="flex flex-wrap items-center gap-2">{isAuthenticated && sitesQuery.data?.length ? <select aria-label="اختيار الفرع أو الملخص المجمع" value={selectedScope === "all" ? "all" : String(siteId ?? "")} onChange={(event) => { const value = event.target.value; if (value === "all") setScope("all"); else { setScope("branch"); setSiteId(Number(value)); } }} className="h-10 max-w-56 rounded-xl border border-white/10 bg-white/[0.02] px-3 text-sm font-bold text-slate-300 outline-none">{canUseAllBranches && <option className="bg-[#111823]" value="all">جميع الأفرع (ملخص مجمّع)</option>}{sitesQuery.data.map((site) => <option className="bg-[#111823]" value={site.id} key={site.id}>{site.name}</option>)}</select> : <span className="inline-flex h-10 items-center rounded-xl border border-white/10 bg-white/[0.02] px-3 text-sm font-bold text-slate-300"><CalendarDays className="ml-2 h-4 w-4" />اليوم</span>}<Button variant="outline" className="border-white/10 bg-white/[0.02] text-slate-200 hover:border-[#F5B800]/40 hover:bg-[#F5B800]/10 hover:text-[#F5B800]" onClick={() => setLocation("/quick-actions")}><Zap className="ml-2 h-4 w-4" />الإجراءات السريعة</Button></div>
    </header>


    {dashboardDataError ? <Card role="alert" className="border-amber-300/30 bg-amber-300/[.06] shadow-panel"><CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-bold text-amber-100">تعذر تحميل بعض بيانات لوحة التحكم</h2><p className="mt-1 text-sm leading-6 text-slate-400">قد تكون بعض المؤشرات غير مكتملة. الشرطة (—) تعني أن البيانات غير متاحة، ولا تعني أن القيمة صفر.</p><ul className="mt-2 space-y-1 text-xs leading-5 text-amber-100/90">{dashboardDataFailures.map((failure) => <li key={failure}>{failure}</li>)}</ul></div><Button type="button" variant="outline" onClick={retryDashboardData} className="shrink-0 border-amber-300/30 text-amber-100 hover:bg-amber-300/10">إعادة تحميل المؤشرات</Button></CardContent></Card> : null}

    <DashboardKpiPeriodFilter
      value={dashboardPeriod.preset}
      onChange={dashboardPeriod.setPreset}
      startDate={dashboardPeriod.startDate}
      endDate={dashboardPeriod.endDate}
      onStartDateChange={dashboardPeriod.setStartDate}
      onEndDateChange={dashboardPeriod.setEndDate}
      disabled={dashboardPeriod.isLoading}
      error={dashboardPeriod.isError || periodMetricsQuery.isError}
      onRetry={() => { dashboardPeriod.retry(); void periodMetricsQuery.refetch(); }}
    />

    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      <MetricCard label="فوترة الفترة" value={periodMetricNumber(periodMetricsQuery.data?.summary.invoiced)} unit="ش" periodLabel={dashboardPeriod.label} description={periodMetricsQuery.isError ? "تعذر تحميل فوترة الفترة المحددة." : `إجمالي الفواتير الصادرة من ${dashboardPeriod.startDate} إلى ${dashboardPeriod.endDate}.`} icon={ReceiptText} accent="gold" />
      <MetricCard label="تحصيل الفترة" value={periodMetricNumber(periodMetricsQuery.data?.summary.collected)} unit="ش" periodLabel={dashboardPeriod.label} description={periodMetricsQuery.isError ? "تعذر تحميل تحصيل الفترة المحددة." : "الدفعات المكتملة بتاريخ التحصيل ضمن الفترة المحددة."} icon={CircleDollarSign} accent="emerald" />
      <MetricCard label="نسبة التحصيل" value={periodMetricRatio(periodMetricsQuery.data?.summary.collectionRate)} unit="" periodLabel={dashboardPeriod.label} description="التحصيل المكتمل مقارنة بإجمالي الفوترة في الفترة نفسها." icon={ArrowUpLeft} accent="blue" />
      <div role="button" tabIndex={!siteId || !dashboardPeriod.isReady ? -1 : 0} aria-label="فتح المتأخرات في تبويب المشتركين للفترة المحددة" aria-disabled={!siteId || !dashboardPeriod.isReady} onClick={openPeriodArrears} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openPeriodArrears(); } }} className="block w-full min-w-0 cursor-pointer rounded-2xl text-right outline-none transition focus-visible:ring-2 focus-visible:ring-[#F5B800] aria-disabled:cursor-wait aria-disabled:opacity-70">
        <MetricCard label="المتأخرات" value={periodMetricNumber(periodMetricsQuery.data?.summary.overdue)} unit="ش" periodLabel={dashboardPeriod.label} description={periodMetricsQuery.isError ? "تعذر تحميل المتأخرات للفترة المحددة." : `${number(periodMetricsQuery.data?.summary.overdueSubscriberCount)} مشتركاً بفواتير متأخرة صادرة ضمن الفترة. اضغط لعرض التفاصيل.`} icon={CircleAlert} accent="rose" />
      </div>
      <MetricCard label="المشتركون النشطون" value={metricNumber(activeSubscribers)} unit="مشترك" periodLabel="العدد الحالي" description={financialOverviewQuery.isError ? "تعذر تحميل عدد المشتركين." : selectedScope === "all" ? `عبر ${overview?.branchSummaries.length ?? 0} أفرع.` : "ضمن الفرع المحدد."} icon={UsersRound} accent="blue" />
    </section>

    <FinancialTrendSection data={overview?.trend ?? []} loading={financialOverviewQuery.isLoading} />

    <OperationalStatusDashboardCard subscribers={activeSubscribers} generators={operationalSummary?.generators} subscribersUnavailable={financialOverviewQuery.isError} generatorsUnavailable={selectedScope === "all" ? allBranchesSummaryQuery.isError : summaryQuery.isError} loading={financialOverviewQuery.isLoading || (selectedScope === "all" ? allBranchesSummaryQuery.isLoading : summaryQuery.isLoading)} scopeLabel={selectedScope === "all" ? "جميع الأفرع" : "الفرع المحدد"} />

    {failedQuotaLabels.length > 0 ? <QuotaLoadErrorCard labels={failedQuotaLabels} onRetry={retryFailedQuotaQueries} /> : null}
    {accessQuery.data?.role === "owner" && !smsQuotaQuery.isError ? <SmsQuotaDashboardCard quota={smsQuotaQuery.data} loading={smsQuotaQuery.isLoading} packages={smsCreditPackagesQuery.data ?? []} packageRequest={smsPackageRequestQuery.data} packageRequestLoading={smsPackageRequestQuery.isLoading} packageRequestError={smsPackageRequestQuery.isError} requestingPackage={requestSmsPackage.isPending} onRetryPackageRequest={() => smsPackageRequestQuery.refetch()} onRequestPackage={(packageId, note) => requestSmsPackage.mutate({ siteId: siteId!, packageId, note })} onOpen={() => setLocation("/notifications")} /> : null}
    {!subscriberQuotaQuery.isError ? <SubscriberQuotaDashboardCard packageCodes={packageCodes} quota={subscriberQuotaQuery.data} upgradeRequest={upgradeRequestQuery.data ? { ...upgradeRequestQuery.data, requestedPackageCode: upgradeRequestQuery.data.requestedPackageCode } : null} addonRequests={addonRequestsQuery.data ?? []} canRequestUpgrade={accessQuery.data?.role === "owner"} requesting={requestUpgrade.isPending} requestingAddon={requestAddon.isPending} onRequestUpgrade={(requestedPackageCode) => requestUpgrade.mutate({ siteId: siteId!, requestedPackageCode })} onRequestAddon={() => requestAddon.mutate({ siteId: siteId!, addonCode: "subscribers50", quantity: 1 })} /> : null}
    {/* Branch quota dashboard card intentionally hidden per owner request; the feature and branch-management route remain available. */}
    {accessQuery.data?.role === "owner" && !subaccountQuotaQuery.isError ? <TeamQuotaDashboardCard subaccountQuota={subaccountQuotaQuery.data} loading={subaccountQuotaQuery.isLoading} /> : null}
    <CompanyBalancesDashboardCard accounts={companyAccountsQuery.data ?? []} loading={companyAccountsQuery.isLoading} error={companyAccountsQuery.isError} onRetry={() => companyAccountsQuery.refetch()} onOpen={() => setLocation("/company-accounts")} />

    <section className="grid gap-6 xl:grid-cols-[1.35fr_.85fr]">
      <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="flex flex-col gap-3 border-b border-white/8 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6"><div><h2 className="font-bold text-white">نبض التحصيل</h2><p className="mt-1 text-sm text-slate-400">قراءة سريعة لنتيجة اليوم ووضع الشهر المالي.</p></div><Badge className="w-fit border-[#F5B800]/20 bg-[#F5B800]/10 text-[#F5B800] hover:bg-[#F5B800]/10">{selectedScope === "all" ? "جميع الأفرع" : "الفرع المحدد"}</Badge></div><div className="grid gap-4 p-5 sm:grid-cols-2"><div className="rounded-2xl border border-sky-400/15 bg-sky-400/[.045] p-5"><div className="flex items-center gap-2 text-sm font-bold text-sky-200"><CalendarDays className="h-4 w-4" />نتيجة اليوم</div><p className="mt-5 font-display text-3xl font-extrabold text-white">{metricNumber(overview?.today.collected, 2)}</p><p className="mt-1 text-xs text-slate-400">تحصيل اليوم من فوترة {metricNumber(overview?.today.invoiced, 2)}</p><div className="mt-5 h-2 overflow-hidden rounded-full bg-sky-950/80"><div className="h-full rounded-full bg-sky-400 transition-[width] duration-300" style={{ width: `${Math.min(100, Number(overview?.today.collectionRate ?? 0))}%` }} /></div><p className="mt-2 text-xs font-bold text-sky-200">نسبة تحصيل اليوم: {metricRatio(overview?.today.collectionRate)}</p></div><div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[.045] p-5"><div className="flex items-center gap-2 text-sm font-bold text-emerald-200"><CircleDollarSign className="h-4 w-4" />صافي النقد الشهري</div><p className="mt-5 font-display text-3xl font-extrabold text-white">{metricNumber(overview?.month.netCash, 2)}</p><p className="mt-1 text-xs text-slate-400">التحصيل {metricNumber(overview?.month.collected, 2)} − المصروفات {metricNumber(overview?.month.expenses, 2)}</p><div className="mt-5 flex items-center justify-between rounded-xl border border-white/8 bg-[#0D1117]/35 px-3 py-2 text-xs"><span className="text-slate-400">نسبة تحصيل الشهر</span><strong className="text-emerald-300">{metricRatio(overview?.month.collectionRate)}</strong></div></div></div></CardContent></Card>
      <Card className="border-rose-400/20 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="flex items-center justify-between border-b border-white/8 px-5 py-5"><div><h2 className="font-bold text-white">تحتاج متابعة الآن</h2><p className="mt-1 text-sm text-slate-400">أولوية التحصيل والذمم المفتوحة.</p></div><Clock3 className="h-5 w-5 text-rose-300" /></div><div className="divide-y divide-white/8"><StateLine label="رصيد متأخر" value={metricNumber(overview?.outstanding.overdue, 2)} hint="فواتير تجاوزت تاريخ الاستحقاق." tone="bg-rose-400" /><StateLine label="دفعات جزئية" value={metricNumber(overview?.outstanding.partialInvoices)} hint="فواتير تحتاج متابعة الرصيد المتبقي." tone="bg-amber-400" /><StateLine label="حسابات مفتوحة" value={metricNumber(overview?.outstanding.accountCount)} hint="مشتركون لديهم رصيد قائم." tone="bg-sky-400" /></div></CardContent></Card>
    </section>

    <section className="grid gap-6 xl:grid-cols-[1.15fr_.85fr]">
      <DebtorsCard rows={overview?.topDebtors ?? []} allBranches={selectedScope === "all"} loading={financialOverviewQuery.isLoading} error={financialOverviewQuery.isError} onOpenCollections={() => setLocation("/collections")} />
      <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-6"><div className="flex items-center justify-between"><div className="flex items-center gap-2 text-[#F5B800]"><BellRing className="h-4 w-4" /><span className="text-xs font-bold">حالة المتابعة</span></div><span className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] text-slate-400">{number(operationalSummary?.failedNotifications)} رسالة فاشلة</span></div><h2 className="mt-6 text-xl font-extrabold text-white">متابعة التحصيل من مصدر واحد</h2><p className="mt-3 text-sm leading-7 text-slate-400">{`هذا الملخص من بيانات ${selectedScope === "all" ? "جميع الأفرع" : "الفرع المحدد"} لمتابعة حالة الرسائل فقط. لإصدار الفواتير أو التحصيل أو فتح التقارير، استخدم تبويب الإجراءات السريعة أو التبويب المتخصص من القائمة الجانبية.`}</p></CardContent></Card>
    </section>

    {selectedScope === "all" && <BranchPerformanceCard rows={overview?.branchSummaries ?? []} loading={financialOverviewQuery.isLoading} error={financialOverviewQuery.isError} onOpenReports={() => setLocation("/reports")} />}

    {/* Keep subscription duration and renewal information at the end of the dashboard. */}
    <SubscriptionRenewalDashboardCard data={ownerRenewalQuery.data} loading={ownerRenewalQuery.isLoading} error={ownerRenewalQuery.isError} ownerAccessVerified={accessQuery.data?.role === "owner"} ownerAccessLoading={accessQuery.isLoading} ownerAccessError={accessQuery.isError} onRetry={() => ownerRenewalQuery.refetch()} onContact={() => setLocation("/support")} />

  </div></DashboardLayout>;
}

function DebtorsCard({
  rows, allBranches, loading = false, error = false, onOpenCollections,
}: {
  rows: Array<{ subscriber: string; subscriberNo: string; branchName: string; outstanding: number; ageDays: number; partialInvoices: number; isOverdue: boolean }>;
  allBranches: boolean;
  loading?: boolean;
  error?: boolean;
  onOpenCollections: () => void;
}) {
  return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0">
    <div className="flex items-center justify-between border-b border-white/8 px-5 py-5"><div><h2 className="font-bold text-white">أولوية المتأخرات</h2><p className="mt-1 text-sm text-slate-400">مرتبة حسب تجاوز الاستحقاق ثم الرصيد المتبقي.</p></div><CircleAlert className="h-5 w-5 text-rose-300" /></div>
    <div className="overflow-x-auto p-5">
      {loading ? <div className="rounded-xl border border-white/8 px-4 py-10 text-center text-sm text-slate-400">جارٍ تحميل بيانات المتأخرات...</div>
        : error ? <div role="status" className="rounded-xl border border-rose-400/20 px-4 py-10 text-center text-sm text-rose-200">تعذر تحميل أولوية المتأخرات. أعد تحميل مؤشرات لوحة التحكم.</div>
        : rows.length ? <table className="w-full min-w-[590px] text-sm"><thead className="text-right text-xs text-slate-500"><tr>{allBranches && <th className="pb-3">الفرع</th>}<th className="pb-3">المشترك</th><th className="pb-3">الرصيد</th><th className="pb-3">عمر الدين</th><th className="pb-3">الحالة</th></tr></thead><tbody>{rows.map((row) => <tr className="border-t border-white/7" key={`${row.branchName}-${row.subscriberNo}`}>{allBranches && <td className="py-3 text-slate-400">{row.branchName}</td>}<td className="py-3"><p className="font-bold text-white">{row.subscriber}</p><p className="mt-1 font-display text-[11px] text-[#F5B800]" dir="ltr">{row.subscriberNo}</p></td><td className="py-3 font-bold text-rose-200">{number(row.outstanding, 2)}</td><td className="py-3 text-slate-300">{row.isOverdue ? `${number(row.ageDays)} يوم` : "غير مستحق بعد"}</td><td className="py-3"><Badge className={row.isOverdue ? "border-rose-400/20 bg-rose-400/10 text-rose-300" : "border-amber-400/20 bg-amber-400/10 text-amber-200"}>{row.partialInvoices ? "دفعة جزئية" : row.isOverdue ? "متأخر" : "مستحق قريباً"}</Badge></td></tr>)}</tbody></table>
        : <div className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-slate-500">لا توجد أرصدة مفتوحة ضمن النطاق الحالي.</div>}
    </div>
    <button onClick={onOpenCollections} className="flex w-full items-center justify-between border-t border-white/8 px-5 py-4 text-sm font-bold text-[#F5B800] transition hover:bg-[#F5B800]/5">إدارة التحصيلات والفواتير <ChevronLeft className="h-4 w-4" /></button>
  </CardContent></Card>;
}

function BranchPerformanceCard({
  rows, loading = false, error = false, onOpenReports,
}: {
  rows: Array<{ id: number; name: string; activeSubscribers: number; invoiced: number; collected: number; outstanding: number; collectionRate: number }>;
  loading?: boolean;
  error?: boolean;
  onOpenReports: () => void;
}) {
  return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0">
    <div className="flex items-center justify-between border-b border-white/8 px-5 py-5"><div><h2 className="font-bold text-white">الأداء المالي حسب الفرع</h2><p className="mt-1 text-sm text-slate-400">مقارنة شهرية لتحديد الفروع التي تحتاج تدخلاً.</p></div><Button variant="outline" onClick={onOpenReports} className="border-white/10 text-white hover:bg-white/5 hover:text-white">التقرير التفصيلي</Button></div>
    <div className="overflow-x-auto p-5">
      {loading ? <p className="rounded-xl border border-white/8 px-4 py-10 text-center text-sm text-slate-400">جارٍ تحميل مقارنة الفروع...</p>
        : error ? <p role="status" className="rounded-xl border border-rose-400/20 px-4 py-10 text-center text-sm text-rose-200">تعذر تحميل الأداء المالي للفروع.</p>
        : rows.length ? <table className="w-full min-w-[720px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-3">الفرع</th><th className="pb-3">المشتركون</th><th className="pb-3">الفوترة</th><th className="pb-3">التحصيل</th><th className="pb-3">نسبة التحصيل</th><th className="pb-3">المتأخرات</th></tr></thead><tbody>{rows.map((row) => <tr className="border-t border-white/7" key={row.id}><td className="py-3 font-bold text-white">{row.name}</td><td className="py-3 text-slate-300">{number(row.activeSubscribers)}</td><td className="py-3 text-slate-300">{number(row.invoiced, 2)}</td><td className="py-3 text-emerald-300">{number(row.collected, 2)}</td><td className="py-3"><span className={row.collectionRate < 70 ? "font-bold text-rose-300" : "font-bold text-emerald-300"}>{ratio(row.collectionRate)}</span></td><td className="py-3 font-bold text-rose-200">{number(row.outstanding, 2)}</td></tr>)}</tbody></table>
        : <p className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-slate-500">لا توجد فروع نشطة لعرض المقارنة.</p>}
    </div>
  </CardContent></Card>;
}

export default function Home() { return <MarketingLandingPage />; }
