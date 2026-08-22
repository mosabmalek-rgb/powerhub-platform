import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { startLogin } from "@/const";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import BulkReadingEntry from "@/components/BulkReadingEntry";
import ReadingWorkflowPanel from "@/components/ReadingWorkflowPanel";
import PendingReadingsReview from "@/components/PendingReadingsReview";
import BranchAnomalySettings from "@/components/BranchAnomalySettings";
import { enqueueReading, listQueuedReadings, removeQueuedReading, type QueuedReading, updateQueuedReading } from "@/lib/offline-reading-queue";
import { trpc } from "@/lib/trpc";
import ExcelJS from "exceljs";
import { can } from "@shared/powerhub-rbac";
import { Camera, CloudOff, Download, FileSpreadsheet, Gauge, ImagePlus, Loader2, RotateCw, UploadCloud, Wifi, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-right"><span className="mb-2 block text-xs font-bold text-slate-400">{label}</span>{children}</label>;
}

function readImage(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("تعذر قراءة الصورة."));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="border-b border-white/8 px-5 py-4"><h2 className="font-bold text-white">{title}</h2></div><div className="p-5">{children}</div></CardContent></Card>;
}

export default function MeterReadingsPage() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, loading } = useAuth();
  const utils = trpc.useUtils();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const { branchId: siteId, setBranchId: setSiteId } = useBranchFilter(sitesQuery.data);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [queuedReadings, setQueuedReadings] = useState<QueuedReading[]>([]);
  const [isOnline, setIsOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const [exportStartDate, setExportStartDate] = useState("");
  const [exportEndDate, setExportEndDate] = useState("");
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  useEffect(() => { const online = () => setIsOnline(true); const offline = () => setIsOnline(false); window.addEventListener("online", online); window.addEventListener("offline", offline); return () => { window.removeEventListener("online", online); window.removeEventListener("offline", offline); }; }, []);

  const enabled = Boolean(isAuthenticated && siteId);
  const subscribersQuery = trpc.powerhub.subscribers.list.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const metersQuery = trpc.powerhub.meters.list.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const readingsQuery = trpc.powerhub.readings.list.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const accessQuery = trpc.powerhub.staff.myAccess.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const anomalyQuery = trpc.powerhub.sites.anomalyAlert.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const currentSite = useMemo(() => sitesQuery.data?.find((site) => site.id === siteId), [siteId, sitesQuery.data]);
  const role = accessQuery.data?.role;
  const canRecordReading = can(role, "recordReadings");
  const canApproveReading = can(role, "approveReadings");

  const loadQueuedReadings = useCallback(async () => {
    if (!siteId) return;
    try { setQueuedReadings(await listQueuedReadings(siteId)); } catch { toast.error("تعذر قراءة طابور العمل دون اتصال على هذا الجهاز."); }
  }, [siteId]);
  useEffect(() => { void loadQueuedReadings(); }, [loadQueuedReadings]);

  const refresh = async () => {
    await Promise.all([utils.powerhub.meters.list.invalidate(), utils.powerhub.readings.list.invalidate(), utils.powerhub.dashboard.summary.invalidate(), utils.powerhub.audit.list.invalidate()]);
  };
  const clearSelectedImage = () => { setSelectedFile(null); if (previewUrl) URL.revokeObjectURL(previewUrl); setPreviewUrl(null); };
  const addReading = trpc.powerhub.readings.create.useMutation({ onSuccess: async () => { await refresh(); clearSelectedImage(); toast.success("تم حفظ القراءة بانتظار المراجعة."); }, onError: (error) => toast.error(error.message) });
  const approveReading = trpc.powerhub.readings.approve.useMutation({ onSuccess: async () => { await refresh(); toast.success("تم اعتماد القراءة وأصبحت جاهزة للفوترة."); }, onError: (error) => toast.error(error.message) });

  const takeFile = (file: File | undefined) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { toast.error("استخدم صورة JPG أو PNG أو WebP فقط."); return; }
    if (file.size > 7 * 1024 * 1024) { toast.error("يجب ألا يتجاوز حجم الصورة 7 ميغابايت."); return; }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  };

  const exportRows = (rows: any[]) => rows.map((row) => [row.subscriber.fullName, row.subscriber.subscriberNo, row.meter.serialNumber, Number(row.reading.readingValue).toFixed(3), Number(row.reading.consumptionKwh ?? 0).toFixed(3), row.reading.status === "approved" ? "معتمدة" : "بانتظار المراجعة", new Date(row.reading.readingAt).toLocaleDateString("ar")]);
  const downloadFile = (blob: Blob, filename: string) => { const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url); };
  const exportFilteredReadings = () => (readingsQuery.data ?? []).filter((row) => { const date = new Date(row.reading.readingAt).toISOString().slice(0, 10); return (!exportStartDate || date >= exportStartDate) && (!exportEndDate || date <= exportEndDate); });
  const downloadCsv = () => { const rows = [["المشترك", "الرقم المرجعي", "العداد", "القراءة", "الاستهلاك kWh", "الحالة", "التاريخ"], ...exportRows(exportFilteredReadings())]; const csv = "\uFEFF" + rows.map((row) => row.map((cell) => "\"" + String(cell ?? "").replaceAll("\"", "\"\"") + "\"").join(",")).join("\n"); downloadFile(new Blob([csv], { type: "text/csv;charset=utf-8" }), "powerhub-readings-" + new Date().toISOString().slice(0, 10) + ".csv"); toast.success("تم تصدير قائمة القراءات بصيغة CSV."); };
  const downloadExcel = async () => { try { const workbook = new ExcelJS.Workbook(); workbook.creator = "PowerHub"; const sheet = workbook.addWorksheet("القراءات", { views: [{ rightToLeft: true }] }); sheet.addRow(["المشترك", "الرقم المرجعي", "العداد", "القراءة", "الاستهلاك kWh", "الحالة", "التاريخ"]); exportRows(exportFilteredReadings()).forEach((row) => sheet.addRow(row)); sheet.columns = [{ width: 28 }, { width: 20 }, { width: 18 }, { width: 14 }, { width: 18 }, { width: 20 }, { width: 16 }]; const header = sheet.getRow(1); header.font = { bold: true, color: { argb: "FFFFFFFF" } }; header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1117" } }; header.alignment = { horizontal: "right" }; const buffer = await workbook.xlsx.writeBuffer(); downloadFile(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "powerhub-readings-" + new Date().toISOString().slice(0, 10) + ".xlsx"); toast.success("تم تجهيز قائمة القراءات بصيغة Excel."); } catch { toast.error("تعذر تجهيز ملف Excel. حاول مرة أخرى."); } };
  const syncQueuedReadings = async () => {
    if (!siteId || !isOnline) { toast.error("لا يمكن المزامنة قبل عودة الاتصال."); return; }
    const pending = queuedReadings.filter((record) => record.status === "pending");
    if (!pending.length) { toast.message("لا توجد قراءات معلقة للمزامنة."); return; }
    for (const record of pending) {
      try {
        await addReading.mutateAsync({ siteId: record.siteId, meterId: record.meterId, readingValue: record.readingValue, captureMethod: record.captureMethod, clientOperationId: record.clientOperationId, imageData: record.imageData, imageMime: record.imageMime, notes: record.notes });
        await removeQueuedReading(record.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "تعذر إرسال القراءة.";
        const trpcCode = (error as { data?: { code?: string } })?.data?.code;
        const status = trpcCode === "CONFLICT" ? "conflict" : "failed";
        try { await updateQueuedReading(record.id, { status, error: message }); } catch { toast.error("تعذر تحديث حالة العملية المحلية؛ احتفظ بالجهاز متصلاً ثم حاول مجدداً."); }
      }
    }
    await loadQueuedReadings();
  };

  const retryQueuedReading = async (id: string) => { try { await updateQueuedReading(id, { status: "pending", error: undefined }); await loadQueuedReadings(); } catch (error) { toast.error(error instanceof Error ? error.message : "تعذر إعادة تجهيز القراءة للمزامنة."); } };

  if (loading) return <DashboardLayout><div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  if (!isAuthenticated) return <DashboardLayout><div className="mx-auto mt-12 max-w-xl rounded-[28px] border border-[#F5B800]/20 bg-[#111823] p-8 text-center shadow-panel"><Gauge className="mx-auto h-8 w-8 text-[#F5B800]" /><h1 className="mt-5 text-xl font-extrabold text-white">سجّل الدخول لتسجيل القراءات</h1><p className="mt-3 leading-7 text-slate-400">تحتاج قراءة العداد وصورتها إلى مستخدم مصرح له ومحطة محددة.</p><Button onClick={() => startLogin()} className="mt-6 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">تسجيل الدخول</Button></div></DashboardLayout>;
  if (!sitesQuery.data?.length) return <DashboardLayout><div className="mx-auto mt-12 max-w-xl rounded-[28px] border border-white/10 bg-[#111823] p-8 text-center shadow-panel"><h1 className="text-xl font-extrabold text-white">أنشئ محطة أولاً</h1><p className="mt-3 text-slate-400">العدادات والقراءات مرتبطة بمحطة توزيع.</p><Button onClick={() => setLocation("/subscribers")} className="mt-6 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">فتح إعداد المحطة</Button></div></DashboardLayout>;

  return <DashboardLayout><div className="space-y-6 pb-12"><header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823]/80 p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Gauge className="h-4 w-4" />القياس الميداني</div><h1 className="mt-1 text-2xl font-extrabold text-white">إضافة قراءة</h1><p className="mt-2 text-sm text-slate-400">أدخل القراءة، التقط صورة العداد عند الحاجة، ثم أرسلها للمراجعة.</p></div><div className="flex items-center gap-3"><span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${isOnline ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-300"}`}>{isOnline ? <Wifi className="h-3.5 w-3.5" /> : <CloudOff className="h-3.5 w-3.5" />}{isOnline ? "متصل" : "دون اتصال"}</span><select aria-label="فلتر الفرع الموحد" value={siteId ?? ""} onChange={(event) => setSiteId(Number(event.target.value))} className={inputClass}>{sitesQuery.data.map((site) => <option className="bg-[#111823]" key={site.id} value={site.id}>{site.name}</option>)}</select></div></header>
    <BranchAnomalySettings siteId={siteId!} canEdit={role === "owner"} currentPercent={anomalyQuery.data?.anomalyAlertPercent ?? 50} />
    <div className="grid gap-6 xl:grid-cols-2">
      </div>
    {canApproveReading && <PendingReadingsReview siteId={siteId!} rows={readingsQuery.data ?? []} canReview={canApproveReading} onUpdated={refresh} />}
    {canRecordReading && <><ReadingWorkflowPanel siteId={siteId!} role={role} anomalyAlertPercent={anomalyQuery.data?.anomalyAlertPercent ?? 50} meters={metersQuery.data ?? []} readings={readingsQuery.data ?? []} onSaved={refresh} /><BulkReadingEntry siteId={siteId!} meters={metersQuery.data ?? []} readings={readingsQuery.data ?? []} onSaved={refresh} /></>}
    <Panel title={`سجل القراءات — ${currentSite?.name}`}><div className="mb-4 flex flex-wrap items-end gap-2"><label className="text-xs text-slate-400">من تاريخ<input aria-label="بداية نطاق تصدير القراءات" type="date" value={exportStartDate} onChange={(event) => setExportStartDate(event.target.value)} className={`${inputClass} mt-1`} /></label><label className="text-xs text-slate-400">إلى تاريخ<input aria-label="نهاية نطاق تصدير القراءات" type="date" value={exportEndDate} onChange={(event) => setExportEndDate(event.target.value)} className={`${inputClass} mt-1`} /></label><Button type="button" onClick={downloadCsv} disabled={!(readingsQuery.data ?? []).length} variant="outline" className="border-white/10 text-slate-200 hover:bg-white/5"><Download className="ml-2 h-4 w-4" />تصدير CSV</Button><Button type="button" onClick={() => void downloadExcel()} disabled={!(readingsQuery.data ?? []).length} variant="outline" className="border-[#F5B800]/35 text-[#F5B800] hover:bg-[#F5B800]/10"><FileSpreadsheet className="ml-2 h-4 w-4" />تصدير Excel</Button></div><div className="overflow-x-auto">{(readingsQuery.data ?? []).length ? <table className="w-full min-w-[800px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-3">المشترك</th><th className="pb-3">العداد</th><th className="pb-3">القراءة</th><th className="pb-3">الاستهلاك</th><th className="pb-3">الصورة</th><th className="pb-3">الحالة</th><th className="pb-3">إجراء</th></tr></thead><tbody>{(readingsQuery.data ?? []).map((row) => <tr key={row.reading.id} className="border-t border-white/7"><td className="py-3 font-bold text-white">{row.subscriber.fullName}</td><td className="py-3 text-slate-400" dir="ltr">{row.meter.serialNumber}</td><td className="py-3">{Number(row.reading.readingValue).toFixed(3)}</td><td className="py-3 text-[#F5B800]">{Number(row.reading.consumptionKwh ?? 0).toFixed(3)} kWh</td><td className="py-3">{row.reading.imageKey ? <button type="button" onClick={() => setLightboxUrl(`/manus-storage/${row.reading.imageKey}`)} className="overflow-hidden rounded-lg border border-emerald-400/30 hover:border-[#F5B800]" aria-label={`تكبير صورة عداد ${row.subscriber.fullName}`}><img src={`/manus-storage/${row.reading.imageKey}`} alt="صورة العداد" className="h-10 w-14 object-cover" /></button> : <span className="text-slate-600">—</span>}</td><td className="py-3"><Badge className={row.reading.status === "approved" ? "bg-emerald-400/10 text-emerald-400" : "bg-sky-400/10 text-sky-400"}>{row.reading.status === "pending_review" ? "بانتظار المراجعة" : row.reading.status === "approved" ? "معتمدة" : row.reading.status}</Badge></td><td className="py-3">{row.reading.status === "pending_review" && canApproveReading ? <Button size="sm" disabled={approveReading.isPending} onClick={() => approveReading.mutate({ siteId: siteId!, readingId: row.reading.id, baseVersion: row.reading.versionNo })} className="bg-[#F5B800] text-xs font-bold text-[#0D1117] hover:bg-[#ffd23f]">اعتماد</Button> : <span className="text-xs text-slate-600">—</span>}</td></tr>)}</tbody></table> : <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.015] px-4 py-10 text-center text-sm text-slate-500"><Camera className="mx-auto mb-3 h-5 w-5 text-[#F5B800]" />لا توجد قراءات بعد. أضف عداداً ثم ابدأ القراءة الميدانية.</div>}</div></Panel>
    <Panel title="طابور المزامنة الميداني"><div className="flex flex-col gap-4"><div className="flex flex-col gap-3 rounded-xl border border-white/8 bg-white/[0.018] p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-bold text-white">{queuedReadings.length} قراءة محلية معلقة</p><p className="mt-1 text-xs text-slate-500">تبقى العمليات في هذا الجهاز فقط حتى تتصل الشبكة وتُرسل للمراجعة.</p></div><Button variant="outline" disabled={!isOnline || addReading.isPending || !queuedReadings.some((record) => record.status === "pending")} onClick={() => void syncQueuedReadings()} className="border-[#F5B800]/30 text-[#F5B800] hover:bg-[#F5B800]/10"><RotateCw className="ml-2 h-4 w-4" />مزامنة الآن</Button></div>{queuedReadings.length ? <div className="space-y-2">{queuedReadings.map((record) => <div key={record.id} className="flex flex-col gap-3 rounded-xl border border-white/7 bg-white/[0.015] p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-bold text-white">عداد #{record.meterId} · {record.readingValue} kWh</p><p className="mt-1 text-xs text-slate-500">{new Date(record.createdAt).toLocaleString("ar-IQ")}{record.error ? ` · ${record.error}` : ""}</p></div><div className="flex items-center gap-2"><Badge className={record.status === "pending" ? "bg-amber-400/10 text-amber-300" : record.status === "conflict" ? "bg-rose-400/10 text-rose-300" : "bg-slate-400/10 text-slate-300"}>{record.status === "pending" ? "بانتظار المزامنة" : record.status === "conflict" ? "يتطلب مراجعة" : "فشل الإرسال"}</Badge>{record.status !== "pending" && <Button size="sm" variant="outline" onClick={() => void retryQueuedReading(record.id)} className="border-white/15 text-slate-300">إعادة محاولة</Button>}</div></div>)}</div> : <p className="py-3 text-center text-sm text-slate-500">لا توجد عمليات محلية معلقة لهذه المحطة.</p>}</div></Panel>
  </div></DashboardLayout>;
}
