import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { Copy, Download, ExternalLink, ImagePlus, Link2, Loader2, Palette, QrCode, ShieldCheck, Trash2 } from "lucide-react";
import { QRCodeCanvas } from "qrcode.react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";
const codePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function copyPortalUrl(portalUrl: string) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(portalUrl);
    else {
      const input = document.createElement("textarea");
      input.value = portalUrl;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(input);
      if (!copied) throw new Error("copy_failed");
    }
    toast.success("تم نسخ رابط بوابة الاستعلامات.");
  } catch {
    toast.error("تعذر نسخ الرابط. يمكنك نسخه يدوياً من الحقل الظاهر.");
  }
}

export default function SubscriberPortalSettingsPage() {
  const { isAuthenticated, loading } = useAuth();
  const utils = trpc.useUtils();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const [siteId, setSiteId] = useState<number | null>(null);
  useEffect(() => { if (!siteId && sitesQuery.data?.[0]) setSiteId(sitesQuery.data[0].id); }, [siteId, sitesQuery.data]);
  const accessQuery = trpc.powerhub.staff.myAccess.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId && isAuthenticated) });
  const settingsQuery = trpc.powerhub.subscriberPortal.settings.useQuery({ siteId: siteId ?? 0 }, { enabled: Boolean(siteId && isAuthenticated && accessQuery.data?.role === "owner") });
  const [form, setForm] = useState({ portalCode: "", displayName: "", primaryColor: "#0D1117", accentColor: "#F5B800", isEnabled: true });
  const [logoBusy, setLogoBusy] = useState(false);
  const logoUpload = trpc.powerhub.subscriberPortal.uploadLogo.useMutation({ onSuccess: async () => { await utils.powerhub.subscriberPortal.settings.invalidate({ siteId: siteId ?? 0 }); await utils.powerhub.subscriberPortal.theme.invalidate(); toast.success("تم حفظ شعار بوابة الاستعلام."); }, onError: (error) => toast.error(error.message) });
  const logoRemove = trpc.powerhub.subscriberPortal.removeLogo.useMutation({ onSuccess: async () => { await utils.powerhub.subscriberPortal.settings.invalidate({ siteId: siteId ?? 0 }); await utils.powerhub.subscriberPortal.theme.invalidate(); toast.success("تم إزالة شعار بوابة الاستعلام."); }, onError: (error) => toast.error(error.message) });
  useEffect(() => { if (settingsQuery.data) setForm({ portalCode: settingsQuery.data.portalCode, displayName: settingsQuery.data.displayName || "", primaryColor: settingsQuery.data.primaryColor, accentColor: settingsQuery.data.accentColor, isEnabled: settingsQuery.data.isEnabled }); }, [settingsQuery.data]);
  const portalUrl = useMemo(() => `${window.location.origin}/portal?g=${encodeURIComponent(form.portalCode || "your-generator")}`, [form.portalCode]);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const portalReady = codePattern.test(form.portalCode);
  const saveSettings = trpc.powerhub.subscriberPortal.saveSettings.useMutation({ onSuccess: async () => { await Promise.all([utils.powerhub.subscriberPortal.settings.invalidate({ siteId: siteId ?? 0 }), utils.powerhub.subscriberPortal.list.invalidate(), utils.powerhub.subscriberPortal.theme.invalidate()]); toast.success("تم حفظ إعدادات بوابة المشتركين."); }, onError: (error) => toast.error(error.message) });
  const update = (key: keyof typeof form, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));
  const save = (event: FormEvent) => { event.preventDefault(); const code = form.portalCode.trim().toLowerCase(); if (!codePattern.test(code)) { toast.error("استخدم حروفاً إنجليزية صغيرة وأرقاماً وشرطات فقط في رمز الرابط."); return; } if (!siteId) return; saveSettings.mutate({ siteId, ...form, portalCode: code }); };
  const handleLogoChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !siteId) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { toast.error("يسمح فقط بصور PNG أو JPG أو WebP."); return; }
    if (file.size > 3 * 1024 * 1024) { toast.error("يجب ألا يتجاوز حجم الشعار 3 ميغابايت."); return; }
    setLogoBusy(true);
    try {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
        reader.readAsDataURL(file);
      });
      await logoUpload.mutateAsync({ siteId, logoData: base64, logoMime: file.type as "image/png" | "image/jpeg" | "image/webp" });
    } finally { setLogoBusy(false); }
  };
  const removeLogo = async () => { if (!siteId) return; setLogoBusy(true); try { await logoRemove.mutateAsync({ siteId }); } finally { setLogoBusy(false); } };

  const downloadQr = () => {
    const canvas = qrCanvasRef.current;
    if (!canvas || !portalReady) { toast.error("أدخل رمز رابط صحيحاً أولاً لإنشاء رمز QR."); return; }
    try {
      const link = document.createElement("a");
      link.href = canvas.toDataURL("image/png");
      link.download = `PowerHub-QR-${form.portalCode}.png`;
      link.click();
      toast.success("تم تنزيل رمز QR لرابط البوابة.");
    } catch {
      toast.error("تعذر تنزيل رمز QR. حاول مرة أخرى.");
    }
  };

  if (loading) return <DashboardLayout><div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  if (!isAuthenticated) return <DashboardLayout><div className="mx-auto mt-12 max-w-xl rounded-[28px] border border-[#F5B800]/20 bg-[#111823] p-8 text-center shadow-panel"><ShieldCheck className="mx-auto h-8 w-8 text-[#F5B800]" /><h1 className="mt-5 text-xl font-extrabold text-white">سجّل الدخول لإدارة البوابة</h1><p className="mt-3 leading-7 text-slate-400">تخصيص بوابة المشتركين يتطلب حساب مالك المولد.</p></div></DashboardLayout>;

  const isOwner = accessQuery.data?.role === "owner";
  return <DashboardLayout><div className="space-y-6 pb-12"><header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823]/80 p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Palette className="h-4 w-4" />بوابة المشتركين</div><h1 className="mt-1 text-2xl font-extrabold text-white">هوية ورابط البوابة العامة</h1><p className="mt-2 text-sm text-slate-400">خصص الاسم والألوان والرابط الذي ستشاركه مع مشتركي هذا المولد فقط.</p></div>{sitesQuery.data?.length ? <select value={siteId ?? ""} onChange={(event) => setSiteId(Number(event.target.value))} className={inputClass}>{sitesQuery.data.map((site) => <option className="bg-[#111823]" key={site.id} value={site.id}>{site.name}</option>)}</select> : null}</header>
    {!sitesQuery.data?.length ? <Card className="border-white/8 bg-[#111823]"><CardContent className="p-8 text-center text-slate-400">أنشئ محطة أولاً لتتمكن من تفعيل بوابة المشتركين.</CardContent></Card> : accessQuery.isLoading ? <div className="grid min-h-48 place-items-center"><Loader2 className="h-6 w-6 animate-spin text-[#F5B800]" /></div> : !isOwner ? <Card className="border-white/8 bg-[#111823]"><CardContent className="p-8 text-center"><ShieldCheck className="mx-auto h-8 w-8 text-slate-500" /><h2 className="mt-4 font-extrabold text-white">هذه الصفحة مخصصة لمالك المولد</h2><p className="mt-2 text-sm leading-7 text-slate-400">اطلب من مالك المحطة إدارة اسم ورابط وألوان بوابة المشتركين.</p></CardContent></Card> : <div className="grid gap-6 xl:grid-cols-[1.12fr_.88fr]"><Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5 sm:p-6">{settingsQuery.isLoading ? <div className="grid min-h-72 place-items-center"><Loader2 className="h-6 w-6 animate-spin text-[#F5B800]" /></div> : <form className="space-y-5" onSubmit={save}><div><h2 className="font-extrabold text-white">إعدادات المشاركة</h2><p className="mt-1 text-sm text-slate-400">يجب أن يكون الرابط فريداً، ولن يكشف أي بيانات قبل المطابقة بين الرقم المرجعي والهاتف.</p></div><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">اسم المولد الظاهر في البوابة</span><Input required value={form.displayName} onChange={(event) => update("displayName", event.target.value)} className={inputClass} placeholder="مثال: مولد الحي الشمالي" /></label><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">رمز الرابط</span><div className="flex overflow-hidden rounded-xl border border-white/10 focus-within:border-[#F5B800]/70"><span dir="ltr" className="flex items-center bg-white/[.04] px-3 text-xs text-slate-500">?g=</span><input required value={form.portalCode} onChange={(event) => update("portalCode", event.target.value.toLowerCase().replace(/\s+/g, "-"))} className="h-10 min-w-0 flex-1 bg-transparent px-3 text-sm text-white outline-none" placeholder="north" dir="ltr" /></div><p className="mt-2 text-xs text-slate-500">حروف إنجليزية صغيرة وأرقام وشرطات فقط، مثل <span dir="ltr">north</span> أو <span dir="ltr">east-zone</span>.</p></label><div className="grid gap-4 sm:grid-cols-2"><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">اللون الأساسي</span><div className="flex h-10 overflow-hidden rounded-xl border border-white/10"><input aria-label="اللون الأساسي" type="color" value={form.primaryColor} onChange={(event) => update("primaryColor", event.target.value.toUpperCase())} className="h-full w-12 border-0 bg-transparent p-1" /><input value={form.primaryColor} onChange={(event) => update("primaryColor", event.target.value.toUpperCase())} className="min-w-0 flex-1 bg-transparent px-2 text-sm text-white outline-none" dir="ltr" maxLength={7} /></div></label><label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">لون التمييز</span><div className="flex h-10 overflow-hidden rounded-xl border border-white/10"><input aria-label="لون التمييز" type="color" value={form.accentColor} onChange={(event) => update("accentColor", event.target.value.toUpperCase())} className="h-full w-12 border-0 bg-transparent p-1" /><input value={form.accentColor} onChange={(event) => update("accentColor", event.target.value.toUpperCase())} className="min-w-0 flex-1 bg-transparent px-2 text-sm text-white outline-none" dir="ltr" maxLength={7} /></div></label></div><div className="rounded-2xl border border-white/8 bg-white/[.02] p-4"><div className="flex items-center justify-between gap-3"><div><p className="font-bold text-white">شعار صاحب المولد</p><p className="mt-1 text-xs leading-5 text-slate-500">{settingsQuery.data?.logoFeatureAllowed ? (settingsQuery.data?.logoPolicy === "addon" ? "الميزة مفعلة لهذا الاشتراك من إدارة المنصة." : "الميزة مشمولة في باقتك.") : "هذه الميزة غير متاحة ضمن باقتك الحالية أو لم تُفعّل من إدارة المنصة."}</p></div><Badge className={settingsQuery.data?.logoFeatureAllowed ? "bg-emerald-500/10 text-emerald-300" : "bg-white/5 text-slate-500"}>{settingsQuery.data?.logoFeatureAllowed ? "متاحة" : "غير متاحة"}</Badge></div>{settingsQuery.data?.logoFeatureAllowed ? <div className="mt-4 flex flex-wrap items-center gap-3"><div className="grid h-20 w-20 place-items-center overflow-hidden rounded-2xl border border-white/10 bg-white">{settingsQuery.data?.logoUrl ? <img src={settingsQuery.data.logoUrl} alt="شعار صاحب المولد" className="h-full w-full object-contain" /> : <ImagePlus className="h-7 w-7 text-slate-400" />}</div><div className="flex flex-wrap gap-2"><label className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-[#F5B800] px-4 py-2 text-sm font-bold text-[#0D1117] hover:bg-[#ffd23f]"><ImagePlus className="h-4 w-4" />رفع الشعار<input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" disabled={logoBusy} onChange={handleLogoChange} /></label>{settingsQuery.data?.logoConfigured ? <Button type="button" variant="outline" disabled={logoBusy} onClick={() => void removeLogo()} className="border-rose-400/20 text-rose-200 hover:bg-rose-400/10 hover:text-rose-100"><Trash2 className="ml-2 h-4 w-4" />إزالة الشعار</Button> : null}</div></div> : null}</div><div className="flex items-center justify-between rounded-2xl border border-white/8 bg-white/[.02] px-4 py-4"><div><p className="font-bold text-white">تفعيل البوابة العامة</p><p className="mt-1 text-xs leading-5 text-slate-500">عند الإيقاف لا يعمل الرابط ولا تظهر المحطة في قائمة الاختيار.</p></div><Switch checked={form.isEnabled} onCheckedChange={(value) => update("isEnabled", value)} aria-label="تفعيل بوابة المشتركين" /></div><Button disabled={saveSettings.isPending || settingsQuery.isLoading} className="w-full bg-[#F5B800] font-extrabold text-[#0D1117] hover:bg-[#ffd23f]">{saveSettings.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Palette className="ml-2 h-4 w-4" />}حفظ التخصيص</Button></form>}</CardContent></Card>
      <div className="space-y-6"><Card className="overflow-hidden border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0"><div style={{ background: form.primaryColor }} className="p-6"><span style={{ color: form.accentColor }} className="text-xs font-extrabold">معاينة مباشرة</span><h2 className="mt-3 text-xl font-extrabold text-white">{form.displayName || "اسم المولد"}</h2><p className="mt-2 text-sm text-white/65">بوابة استعلامات المشتركين</p></div><div className="p-5"><p className="text-xs font-bold text-slate-400">الرابط الذي ستشاركه</p><div className="mt-2 flex gap-2"><code dir="ltr" className="min-w-0 flex-1 truncate rounded-xl border border-white/8 bg-white/[.03] px-3 py-2.5 text-xs text-slate-300">{portalUrl}</code><Button type="button" size="icon" variant="outline" aria-label="نسخ الرابط سريعاً" className="shrink-0 border-white/12 text-white hover:bg-white/5 hover:text-white" onClick={() => void copyPortalUrl(portalUrl)}><Copy className="h-4 w-4" /></Button></div><div className="mt-4 grid gap-2 sm:grid-cols-2"><Button type="button" className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]" onClick={() => void copyPortalUrl(portalUrl)}><Copy className="ml-2 h-4 w-4" />نسخ رابط البوابة</Button><Button type="button" variant="outline" className="border-white/12 text-white hover:bg-white/5 hover:text-white" onClick={() => window.open(portalUrl, "_blank", "noopener,noreferrer")}><ExternalLink className="ml-2 h-4 w-4" />فتح المعاينة</Button></div><p className="mt-3 flex items-center gap-1.5 text-xs leading-5 text-slate-500"><Link2 className="h-3.5 w-3.5 text-[#F5B800]" />انسخ الرابط ثم شاركه مع المشتركين عبر WhatsApp أو SMS.</p></div></CardContent></Card><Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-center gap-2"><QrCode className="h-4 w-4 text-[#F5B800]" /><h2 className="font-extrabold text-white">رمز QR للبوابة</h2></div><p className="mt-2 text-sm leading-6 text-slate-400">اعرض الرمز للمشتركين أو نزّله كصورة؛ يؤدي مسحه إلى بوابة هذا المولد مباشرة.</p>{portalReady ? <><div className="mx-auto mt-5 w-fit rounded-2xl bg-white p-3 shadow-lg"><QRCodeCanvas ref={qrCanvasRef} value={portalUrl} size={184} level="M" includeMargin bgColor="#FFFFFF" fgColor="#0D1117" /></div><Button type="button" variant="outline" className="mt-5 w-full border-white/12 text-white hover:bg-white/5 hover:text-white" onClick={downloadQr}><Download className="ml-2 h-4 w-4" />تنزيل رمز QR</Button></> : <div className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/[.06] p-4 text-sm leading-6 text-amber-200">أدخل رمز رابط صحيحاً أولاً ليُنشأ رمز QR قابل للمسح.</div>}</CardContent></Card><Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><h2 className="font-extrabold text-white">ضوابط الخصوصية</h2><p className="mt-3 text-sm leading-7 text-slate-400">يطلب الرابط الرقم المرجعي ورقم الهاتف المسجل معاً. لا يتم إرجاع قائمة مشتركي المولد ولا تعرض الفواتير أو المدفوعات إلا بعد المطابقة الناجحة.</p></CardContent></Card></div></div>}</div></DashboardLayout>;
}
