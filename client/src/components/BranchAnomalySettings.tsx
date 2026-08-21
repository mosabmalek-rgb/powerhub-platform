import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, Loader2, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const inputClass = "h-10 w-28 rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none focus:border-[#F5B800]/70";
export default function BranchAnomalySettings({ siteId, canEdit, currentPercent }: { siteId: number; canEdit: boolean; currentPercent: number }) {
  const [percent, setPercent] = useState(String(currentPercent));
  const update = trpc.powerhub.sites.updateAnomalyAlert.useMutation();
  useEffect(() => setPercent(String(currentPercent)), [currentPercent]);
  if (!canEdit) return null;
  const save = async () => {
    const value = Number(percent);
    if (!Number.isInteger(value) || value < 10 || value > 500) { toast.error("أدخل نسبة صحيحة بين 10% و500%."); return; }
    try { await update.mutateAsync({ siteId, anomalyAlertPercent: value }); toast.success("تم حفظ نسبة التنبيه لهذا الفرع."); }
    catch (error) { toast.error(error instanceof Error ? error.message : "تعذر حفظ إعداد الفرع."); }
  };
  return <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="flex items-center gap-2 font-bold text-white"><AlertTriangle className="h-4 w-4 text-[#F5B800]" />إعدادات مراقبة الفرع</h2><p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">فعّل تنبيهاً عندما يتجاوز الاستهلاك متوسط آخر ثلاث قراءات بالنسبة المحددة. الإعداد مستقل لكل فرع.</p></div><div className="flex items-center gap-2"><label className="text-sm text-slate-300">نسبة الزيادة</label><input aria-label="نسبة تنبيه الاستهلاك الشاذ" value={percent} onChange={(event) => setPercent(event.target.value)} type="number" min="10" max="500" step="5" className={inputClass} dir="ltr" /><span className="text-[#F5B800]">%</span><Button disabled={update.isPending} onClick={() => void save()} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">{update.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />}حفظ</Button></div></CardContent></Card>;
}
