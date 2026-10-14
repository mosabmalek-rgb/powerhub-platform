import { AlertTriangle, CalendarClock, CheckCircle2, Clock3, MessageCircle, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getSubscriptionRenewalState } from "@/lib/subscription-renewal-state";

export type OwnerSubscriptionView = {
  packageCode: string;
  status: string;
  billingCycle: string | null;
  startedAt: string | Date | null;
  endsAt: string | Date | null;
  autoRenew: boolean;
  readOnlyUntil: string | Date | null;
  renewalCount: number;
};

export type OwnerSubscriptionQueryData = {
  isOwner: boolean;
  subscription: OwnerSubscriptionView | null;
};

const packageNames: Record<string, string> = {
  basic: "الناشئة",
  advanced: "النمو",
  professional: "الاحتراف",
  business: "الأعمال",
  vip: "الذهبية (VIP)",
};

const cycleLabels: Record<string, string> = { monthly: "شهري", yearly: "سنوي" };
const dateFormatter = new Intl.DateTimeFormat("ar-PS", { dateStyle: "long", timeZone: "Asia/Gaza" });
function displayDate(value: string | Date | null | undefined) {
  if (!value) return "غير محدد";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "غير محدد" : dateFormatter.format(date);
}

const toneClasses = {
  normal: { card: "border-sky-400/20 bg-sky-400/[.035]", icon: "bg-sky-400/10 text-sky-300", badge: "bg-sky-400/10 text-sky-200", iconName: "check" },
  notice: { card: "border-amber-400/25 bg-amber-400/[.04]", icon: "bg-amber-400/10 text-amber-300", badge: "bg-amber-400/10 text-amber-200", iconName: "clock" },
  warning: { card: "border-amber-400/30 bg-amber-400/[.055]", icon: "bg-amber-400/10 text-amber-300", badge: "bg-amber-400/10 text-amber-200", iconName: "warning" },
  urgent: { card: "border-rose-400/30 bg-rose-400/[.055]", icon: "bg-rose-400/10 text-rose-300", badge: "bg-rose-400/10 text-rose-200", iconName: "warning" },
  expired: { card: "border-rose-400/35 bg-rose-400/[.065]", icon: "bg-rose-400/10 text-rose-300", badge: "bg-rose-400/10 text-rose-200", iconName: "warning" },
  blocked: { card: "border-rose-400/25 bg-rose-400/[.045]", icon: "bg-rose-400/10 text-rose-300", badge: "bg-rose-400/10 text-rose-200", iconName: "warning" },
} as const;

type Props = {
  data?: OwnerSubscriptionQueryData;
  loading: boolean;
  error: boolean;
  ownerAccessVerified: boolean;
  onRetry: () => unknown;
  onContact: () => void;
};

export function SubscriptionRenewalDashboardCard({ data, loading, error, ownerAccessVerified, onRetry, onContact }: Props) {
  const isOwner = data?.isOwner === true || ownerAccessVerified;
  if (!isOwner) return null;

  if (error) {
    return <Card role="alert" className="border-rose-400/25 bg-[#111823] shadow-panel"><CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-bold text-rose-200">تعذر تحميل حالة الاشتراك</h2><p className="mt-1 text-sm leading-6 text-slate-300">لم نعرض تاريخًا تخمينيًا. أعد المحاولة للتأكد من موعد التجديد.</p></div><Button type="button" variant="outline" onClick={() => { void onRetry(); }} className="border-white/15 text-white hover:bg-white/5 hover:text-white"><RefreshCw className="ml-2 h-4 w-4" />إعادة المحاولة</Button></CardContent></Card>;
  }

  if (loading && !data?.isOwner) {
    return <Card className="border-white/10 bg-[#111823] shadow-panel" aria-label="جارٍ تحميل الاشتراك"><CardContent className="p-5"><div className="h-4 w-44 animate-pulse rounded bg-white/10" /><div className="mt-4 h-8 w-64 animate-pulse rounded bg-white/10" /></CardContent></Card>;
  }

  const subscription = data?.subscription;
  if (!subscription) {
    return <Card className="border-amber-400/25 bg-amber-400/[.04] shadow-panel"><CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-bold text-white">اشتراكي وتجديدي</h2><p className="mt-1 text-sm leading-6 text-slate-300">لم نعثر على اشتراك مسجل لهذه المساحة. تواصل مع إدارة PowerHub للتحقق من الحساب.</p></div><Button type="button" onClick={onContact} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><MessageCircle className="ml-2 h-4 w-4" />التواصل مع الإدارة</Button></CardContent></Card>;
  }

  const state = getSubscriptionRenewalState(subscription, new Date());
  const tone = toneClasses[state.urgency];
  return <Card className={`${tone.card} shadow-panel`}><CardContent className="p-5 sm:p-6">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${tone.icon}`}>
          {state.urgency === "normal" ? <CheckCircle2 className="h-5 w-5" /> : state.urgency === "notice" ? <Clock3 className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-extrabold text-white">اشتراكي وتجديدي</h2><Badge className={tone.badge}>{state.statusLabel}</Badge></div>
          <p className="mt-1 text-sm text-slate-300">الباقة الحالية: <strong className="text-white">{packageNames[subscription.packageCode] ?? subscription.packageCode}</strong>{subscription.billingCycle ? ` · ${cycleLabels[subscription.billingCycle] ?? subscription.billingCycle}` : ""}</p>
          {state.notice ? <p role="status" className="mt-3 max-w-3xl text-sm font-semibold leading-7 text-slate-200">{state.notice}</p> : <p className="mt-3 text-sm leading-6 text-slate-300">اشتراكك ضمن المدة المسجلة حاليًا. راجع التاريخ أدناه ورتّب التجديد قبل الانتهاء.</p>}
        </div>
      </div>
      <Button type="button" onClick={onContact} className="shrink-0 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><MessageCircle className="ml-2 h-4 w-4" />التواصل لطلب التجديد</Button>
    </div>
    <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div className="rounded-xl border border-white/10 bg-white/[.025] px-4 py-3"><p className="text-xs text-slate-400">بداية الاشتراك</p><p className="mt-2 font-bold text-white">{displayDate(subscription.startedAt)}</p></div>
      <div className="rounded-xl border border-white/10 bg-white/[.025] px-4 py-3"><p className="text-xs text-slate-400">تاريخ الانتهاء</p><p className="mt-2 font-bold text-white">{displayDate(subscription.endsAt)}</p></div>
      <div className="rounded-xl border border-white/10 bg-white/[.025] px-4 py-3"><p className="text-xs text-slate-400">{state.daysRemaining === null ? "المدة المتبقية" : state.daysRemaining === 0 ? "حالة المدة" : "الأيام المتبقية"}</p><p className={`mt-2 font-extrabold ${state.urgency === "expired" || state.urgency === "urgent" || state.urgency === "blocked" ? "text-rose-200" : state.urgency === "warning" || state.urgency === "notice" ? "text-amber-200" : "text-white"}`}>{state.daysRemaining === null ? "غير محددة" : state.daysRemaining === 0 ? "انتهى الاشتراك" : `${state.daysRemaining} يوم`}</p></div>
      <div className="rounded-xl border border-white/10 bg-white/[.025] px-4 py-3"><p className="text-xs text-slate-400">التجديد التلقائي</p><p className="mt-2 font-bold text-white">{subscription.autoRenew ? "مفعّل حسب إعداد الاشتراك" : "غير مفعّل · يتطلب طلب التجديد"}</p></div>
    </div>
    <p className="mt-3 flex items-start gap-2 text-xs leading-6 text-slate-400"><CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />طلب التجديد عبر الدعم لا يمدّد الاشتراك تلقائيًا؛ تعتمد إدارة PowerHub التجديد وتحديث تاريخ الانتهاء.</p>
  </CardContent></Card>;
}
