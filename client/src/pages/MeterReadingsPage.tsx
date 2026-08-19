import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { Camera, Gauge, ImagePlus, Loader2, Plus, UploadCloud } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
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
  const [siteId, setSiteId] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  useEffect(() => { if (!siteId && sitesQuery.data?.[0]) setSiteId(sitesQuery.data[0].id); }, [siteId, sitesQuery.data]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const enabled = Boolean(isAuthenticated && siteId);
  const subscribersQuery = trpc.powerhub.subscribers.list.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const generatorsQuery = trpc.powerhub.generators.list.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const metersQuery = trpc.powerhub.meters.list.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const readingsQuery = trpc.powerhub.readings.list.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const currentSite = useMemo(() => sitesQuery.data?.find((site) => site.id === siteId), [siteId, sitesQuery.data]);

  const refresh = async () => {
    await Promise.all([utils.powerhub.meters.list.invalidate(), utils.powerhub.readings.list.invalidate(), utils.powerhub.dashboard.summary.invalidate(), utils.powerhub.audit.list.invalidate()]);
  };
  const addMeter = trpc.powerhub.meters.create.useMutation({ onSuccess: async () => { await refresh(); toast.success("تمت إضافة العداد."); }, onError: (error) => toast.error(error.message) });
  const addReading = trpc.powerhub.readings.create.useMutation({ onSuccess: async () => { await refresh(); setSelectedFile(null); if (previewUrl) URL.revokeObjectURL(previewUrl); setPreviewUrl(null); toast.success("تم حفظ القراءة بانتظار المراجعة."); }, onError: (error) => toast.error(error.message) });
  const approveReading = trpc.powerhub.readings.approve.useMutation({ onSuccess: async () => { await refresh(); toast.success("تم اعتماد القراءة وأصبحت جاهزة للفوترة."); }, onError: (error) => toast.error(error.message) });

  const takeFile = (file: File | undefined) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { toast.error("استخدم صورة JPG أو PNG أو WebP فقط."); return; }
    if (file.size > 7 * 1024 * 1024) { toast.error("يجب ألا يتجاوز حجم الصورة 7 ميغابايت."); return; }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  };

  if (loading) return <DashboardLayout><div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  if (!isAuthenticated) return <DashboardLayout><div className="mx-auto mt-12 max-w-xl rounded-[28px] border border-[#F5B800]/20 bg-[#111823] p-8 text-center shadow-panel"><Gauge className="mx-auto h-8 w-8 text-[#F5B800]" /><h1 className="mt-5 text-xl font-extrabold text-white">سجّل الدخول لتسجيل القراءات</h1><p className="mt-3 leading-7 text-slate-400">تحتاج قراءة العداد وصورتها إلى مستخدم مصرح له ومحطة محددة.</p><Button onClick={() => startLogin()} className="mt-6 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">تسجيل الدخول</Button></div></DashboardLayout>;
  if (!sitesQuery.data?.length) return <DashboardLayout><div className="mx-auto mt-12 max-w-xl rounded-[28px] border border-white/10 bg-[#111823] p-8 text-center shadow-panel"><h1 className="text-xl font-extrabold text-white">أنشئ محطة أولاً</h1><p className="mt-3 text-slate-400">العدادات والقراءات مرتبطة بمحطة توزيع.</p><Button onClick={() => setLocation("/subscribers")} className="mt-6 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">فتح إعداد المحطة</Button></div></DashboardLayout>;

  return <DashboardLayout><div className="space-y-6 pb-12"><header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823]/80 p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Gauge className="h-4 w-4" />القياس الميداني</div><h1 className="mt-1 text-2xl font-extrabold text-white">العدادات والقراءات</h1><p className="mt-2 text-sm text-slate-400">أدخل القراءة، التقط صورة العداد عند الحاجة، ثم أرسلها للمراجعة.</p></div><select value={siteId ?? ""} onChange={(event) => setSiteId(Number(event.target.value))} className={inputClass}>{sitesQuery.data.map((site) => <option className="bg-[#111823]" key={site.id} value={site.id}>{site.name}</option>)}</select></header>
    <div className="grid gap-6 xl:grid-cols-2"><Panel title="إضافة عداد"><form className="grid gap-4 sm:grid-cols-2" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); addMeter.mutate({ siteId: siteId!, subscriberId: Number(data.get("subscriber")), generatorId: data.get("generator") ? Number(data.get("generator")) : undefined, serialNumber: String(data.get("serial")), meterType: String(data.get("type")) as "manual" | "digital" | "smart", multiplier: String(data.get("multiplier")) }); event.currentTarget.reset(); }}><Field label="المشترك"><select required name="subscriber" className={inputClass}><option value="">اختر المشترك</option>{(subscribersQuery.data ?? []).map((subscriber) => <option className="bg-[#111823]" key={subscriber.id} value={subscriber.id}>{subscriber.fullName}</option>)}</select></Field><Field label="المولد"><select name="generator" className={inputClass}><option value="">غير مرتبط حالياً</option>{(generatorsQuery.data ?? []).map((generator) => <option className="bg-[#111823]" key={generator.id} value={generator.id}>{generator.name}</option>)}</select></Field><Field label="رقم العداد"><input required name="serial" className={inputClass} placeholder="MTR-0001" dir="ltr" /></Field><Field label="نوع العداد"><select name="type" className={inputClass}><option value="manual">يدوي</option><option value="digital">رقمي</option><option value="smart">ذكي</option></select></Field><Field label="معامل العداد"><input required name="multiplier" defaultValue="1" className={inputClass} dir="ltr" /></Field><div className="self-end"><Button disabled={addMeter.isPending || !(subscribersQuery.data?.length)} className="w-full bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><Plus className="ml-2 h-4 w-4" />إضافة العداد</Button></div></form></Panel>
      <Panel title="تسجيل قراءة جديدة"><form className="grid gap-4 sm:grid-cols-2" onSubmit={async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); let imageData: string | undefined; if (selectedFile) imageData = await readImage(selectedFile); addReading.mutate({ siteId: siteId!, meterId: Number(data.get("meter")), readingValue: String(data.get("reading")), captureMethod: imageData ? "photo" : String(data.get("method")) as "manual" | "smart_meter", imageData, imageMime: imageData ? selectedFile?.type as "image/jpeg" | "image/png" | "image/webp" : undefined, notes: String(data.get("notes") || "") || undefined }); event.currentTarget.reset(); }}><Field label="العداد"><select required name="meter" className={inputClass}><option value="">اختر العداد</option>{(metersQuery.data ?? []).map((row) => <option className="bg-[#111823]" key={row.meter.id} value={row.meter.id}>{row.meter.serialNumber} — {row.subscriber.fullName}</option>)}</select></Field><Field label="القراءة الحالية"><input required name="reading" type="number" min="0" step="0.001" className={inputClass} placeholder="0.000" dir="ltr" /></Field><Field label="طريقة الإدخال"><select name="method" className={inputClass}><option value="manual">يدوي</option><option value="smart_meter">عداد ذكي</option></select></Field><Field label="ملاحظة"><input name="notes" className={inputClass} placeholder="اختياري" /></Field><div className="sm:col-span-2"><input id="meter-image" type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => takeFile(event.target.files?.[0])} /><label htmlFor="meter-image" className="flex cursor-pointer items-center justify-between rounded-xl border border-dashed border-white/15 bg-white/[0.015] p-3 transition hover:border-[#F5B800]/50"><span className="flex items-center gap-2 text-sm text-slate-300"><ImagePlus className="h-4 w-4 text-[#F5B800]" />{selectedFile ? selectedFile.name : "إرفاق صورة العداد (اختياري)"}</span><span className="text-xs text-slate-500">JPG · PNG · WebP · حتى 7MB</span></label>{previewUrl && <div className="mt-3 overflow-hidden rounded-xl border border-white/10"><img src={previewUrl} alt="معاينة صورة العداد" className="h-40 w-full object-cover" /></div>}</div><div className="sm:col-span-2"><Button disabled={addReading.isPending || !(metersQuery.data?.length)} className="w-full bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><UploadCloud className="ml-2 h-4 w-4" />حفظ وإرسال للمراجعة</Button></div></form></Panel></div>
    <Panel title={`سجل القراءات — ${currentSite?.name}`}><div className="overflow-x-auto">{(readingsQuery.data ?? []).length ? <table className="w-full min-w-[800px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-3">المشترك</th><th className="pb-3">العداد</th><th className="pb-3">القراءة</th><th className="pb-3">الاستهلاك</th><th className="pb-3">الصورة</th><th className="pb-3">الحالة</th><th className="pb-3">إجراء</th></tr></thead><tbody>{(readingsQuery.data ?? []).map((row) => <tr key={row.reading.id} className="border-t border-white/7"><td className="py-3 font-bold text-white">{row.subscriber.fullName}</td><td className="py-3 text-slate-400" dir="ltr">{row.meter.serialNumber}</td><td className="py-3">{Number(row.reading.readingValue).toFixed(3)}</td><td className="py-3 text-[#F5B800]">{Number(row.reading.consumptionKwh ?? 0).toFixed(3)} kWh</td><td className="py-3">{row.reading.imageKey ? <span className="text-emerald-400">مرفقة</span> : <span className="text-slate-600">—</span>}</td><td className="py-3"><Badge className={row.reading.status === "approved" ? "bg-emerald-400/10 text-emerald-400" : "bg-sky-400/10 text-sky-400"}>{row.reading.status === "pending_review" ? "بانتظار المراجعة" : row.reading.status === "approved" ? "معتمدة" : row.reading.status}</Badge></td><td className="py-3">{row.reading.status === "pending_review" ? <Button size="sm" disabled={approveReading.isPending} onClick={() => approveReading.mutate({ siteId: siteId!, readingId: row.reading.id, baseVersion: row.reading.versionNo })} className="bg-[#F5B800] text-xs font-bold text-[#0D1117] hover:bg-[#ffd23f]">اعتماد</Button> : <span className="text-xs text-slate-600">—</span>}</td></tr>)}</tbody></table> : <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.015] px-4 py-10 text-center text-sm text-slate-500"><Camera className="mx-auto mb-3 h-5 w-5 text-[#F5B800]" />لا توجد قراءات بعد. أضف عداداً ثم ابدأ القراءة الميدانية.</div>}</div></Panel>
  </div></DashboardLayout>;
}
