import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { ArrowRight, CheckCircle2, Clock3, Loader2, Smartphone, UserRound } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { useLocation, useRoute } from "wouter";

const statusLabel = { draft: "مسودة", pending_review: "بانتظار المراجعة", approved: "معتمدة", rejected: "مرفوضة" } as const;

export default function MobileReadingDetailPage() {
  const { isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/mobile-sync/readings/:readingId");
  const readingId = Number(params?.readingId ?? 0);
  const siteId = Number(new URLSearchParams(window.location.search).get("siteId") ?? 0);
  const detail = trpc.powerhub.mobileSync.readingDetail.useQuery({ siteId, readingId }, { enabled: isAuthenticated && siteId > 0 && readingId > 0 });
  const approveAndIssue = trpc.powerhub.mobileSync.approveAndIssue.useMutation();
  const [sendNow, setSendNow] = useState(true);
  const row = detail.data;
  const approve = async () => {
    if (!row || row.status !== "pending_review" || approveAndIssue.isPending) return;
    try {
      const result = await approveAndIssue.mutateAsync({ siteId, readingId, baseVersion: row.versionNo, sendNow });
      const delivery = result.delivery;
      if (delivery.failed) toast.warning(`تم إصدار الفاتورة ${result.invoiceNo}، لكن تعذر إرسال ${delivery.failed} إشعاراً؛ يمكنك إعادة المحاولة من سجل الرسائل.`);
      else if (delivery.submitted) toast.success(`تم اعتماد القراءة وإصدار الفاتورة ${result.invoiceNo} وإرسال ${delivery.submitted} إشعار.`);
      else toast.success(`تم اعتماد القراءة وإصدار الفاتورة ${result.invoiceNo}.`);
      await detail.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "تعذر اعتماد القراءة وإصدار الفاتورة.");
    }
  };

  return <DashboardLayout><main className="mx-auto max-w-5xl space-y-6 pb-12" dir="rtl">
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-white/8 bg-[#111823] p-5 shadow-panel"><div><p className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Smartphone className="h-4 w-4" />قراءة مستلمة من الميدان</p><h1 className="mt-1 text-2xl font-extrabold text-white">تفاصيل القراءة والمشترك</h1></div><div className="flex flex-wrap items-center gap-2"><label className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-white/[0.025] px-3 py-2 text-xs text-slate-300"><input type="checkbox" checked={sendNow} onChange={(event) => setSendNow(event.target.checked)} className="h-4 w-4 accent-[#F5B800]" />إرسال الإشعار فوراً</label><Button disabled={!row || row.status !== "pending_review" || approveAndIssue.isPending} onClick={() => void approve()} className="bg-emerald-500 font-bold text-white hover:bg-emerald-400">{approveAndIssue.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="ml-2 h-4 w-4" />}اعتماد وإصدار فاتورة</Button><Button variant="outline" onClick={() => setLocation("/mobile-sync")} className="border-white/15 text-slate-200"><ArrowRight className="ml-2 h-4 w-4" />العودة إلى الميدان والمزامنة</Button></div></header>
    {detail.isLoading ? <div className="grid h-64 place-items-center"><Loader2 className="h-8 w-8 animate-spin text-[#F5B800]" /></div> : row ? <><section className="grid gap-4 md:grid-cols-2"><Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><p className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><UserRound className="h-4 w-4" />بيانات المشترك</p><h2 className="mt-3 text-xl font-extrabold text-white">{row.subscriberName}</h2><p className="mt-2 font-mono text-sm text-slate-400">{row.subscriberNo}</p></CardContent></Card><Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><p className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Clock3 className="h-4 w-4" />حالة وتوقيت</p><div className="mt-3 flex items-center gap-3"><Badge className="bg-sky-500/15 text-sky-300">{statusLabel[row.status]}</Badge><span className="text-sm text-slate-400">تمت المزامنة: {new Date(row.syncedAt).toLocaleString("ar-IQ")}</span></div></CardContent></Card></section><Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="grid gap-5 p-6 sm:grid-cols-3"><div><p className="text-xs text-slate-500">القراءة السابقة</p><p className="mt-2 text-3xl font-extrabold text-slate-200">{row.previousReading ?? "—"}</p></div><div><p className="text-xs text-slate-500">القراءة الحالية</p><p className="mt-2 text-3xl font-extrabold text-emerald-300">{row.currentReading}</p></div><div><p className="text-xs text-slate-500">الاستهلاك</p><p className="mt-2 text-3xl font-extrabold text-[#F5B800]">{row.consumptionKwh ?? "—"}</p></div><div className="sm:col-span-3 grid gap-3 border-t border-white/8 pt-5 text-sm text-slate-400 sm:grid-cols-3"><p>وقت القراءة: <span className="text-white">{new Date(row.readingAt).toLocaleString("ar-IQ")}</span></p><p>الفني: <span className="text-white">{row.technicianName ?? row.technicianEmail ?? "غير معروف"}</span></p><p>طريقة الالتقاط: <span className="text-white">{row.captureMethod === "photo" ? "صورة" : "إدخال يدوي"}</span></p>{row.notes && <p className="sm:col-span-3">ملاحظات: <span className="text-white">{row.notes}</span></p>}</div></CardContent></Card></> : <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-10 text-center text-slate-400">تعذر العثور على قراءة ميدانية ضمن الفرع المحدد أو لا تملك صلاحية عرضها.</CardContent></Card>}
  </main></DashboardLayout>;
}
