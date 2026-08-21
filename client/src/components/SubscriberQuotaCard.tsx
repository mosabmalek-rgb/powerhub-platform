import { Card, CardContent } from "@/components/ui/card";

type SubscriberQuota = { limit: number; currentCount: number; remaining: number; plan: string };

export function SubscriberQuotaCard({ quota }: { quota?: SubscriberQuota }) {
  if (!quota) return null;
  const exhausted = quota.remaining === 0;
  return <Card className={exhausted ? "border-rose-400/25 bg-rose-400/[.05] shadow-panel" : "border-[#F5B800]/20 bg-[#F5B800]/[.04] shadow-panel"}><CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className={exhausted ? "font-bold text-rose-200" : "font-bold text-[#F5B800]"}>حصة المشتركين في باقة {quota.plan}</p><p className="mt-1 text-sm leading-6 text-slate-300">يُحسب الحد على مستوى جميع خدمات صاحب المولد. لا يمكن إضافة مشترك جديد بعد بلوغ الحد حتى تتم ترقية الباقة أو تعديل السياسة.</p></div><div className="grid grid-cols-3 gap-2 text-center text-xs"><Stat label="المستخدم" value={quota.currentCount} /><Stat label="الحد" value={quota.limit} /><Stat label="المتبقي" value={quota.remaining} tone={exhausted ? "rose" : "gold"} /></div></CardContent></Card>;
}

function Stat({ label, value, tone = "gold" }: { label: string; value: number; tone?: "gold" | "rose" }) { return <div className="min-w-16 rounded-lg border border-white/10 bg-[#0D1117]/35 px-2 py-2"><span className="block text-slate-500">{label}</span><strong className={`mt-1 block text-sm ${tone === "rose" ? "text-rose-300" : "text-[#F5B800]"}`}>{value}</strong></div>; }
