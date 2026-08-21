import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SubscriberQuotaCard } from "@/components/SubscriberQuotaCard";
import { startLogin } from "@/const";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { filterAndSortDebtors, filterDebtorsByQuery } from "@/lib/debtor-search";
import { can } from "@shared/powerhub-rbac";
import { Bolt, CircleAlert, Clock3, Copy, Loader2, Pencil, Plus, UsersRound, WalletCards } from "lucide-react";
import { FormEvent, ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";

type DirectoryKind = "subscribers" | "generators";
type Values = Record<string, string | number | undefined>;
const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3 text-sm text-white outline-none transition focus:border-[#F5B800]/70 focus:ring-2 focus:ring-[#F5B800]/15";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">{label}</span>{children}</label>;
}

export default function NetworkDirectoryPage({ kind }: { kind: DirectoryKind }) {
  const { isAuthenticated, loading } = useAuth();
  const utils = trpc.useUtils();
  const sitesQuery = trpc.powerhub.sites.list.useQuery(undefined, { enabled: isAuthenticated });
  const { branchId: siteId, setBranchId: setSiteId } = useBranchFilter(sitesQuery.data);
  const [editing, setEditing] = useState<any>(null);
  const enabled = Boolean(siteId && isAuthenticated);
  const accessQuery = trpc.powerhub.staff.myAccess.useQuery({ siteId: siteId ?? 0 }, { enabled });
  const subscribersQuery = trpc.powerhub.subscribers.list.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && kind === "subscribers" });
  const subscriberQuotaQuery = trpc.powerhub.subscribers.quota.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && kind === "subscribers" });
  const financialOverviewQuery = trpc.powerhub.dashboard.financialOverview.useQuery({ siteId: siteId ?? 0, scope: "branch" }, { enabled: enabled && kind === "subscribers" });
  const generatorsQuery = trpc.powerhub.generators.list.useQuery({ siteId: siteId ?? 0 }, { enabled: enabled && kind === "generators" });
  const role = accessQuery.data?.role;
  const canEdit = kind === "subscribers" ? can(role, "manageSubscribers") : can(role, "manageGenerators");
  const data: any[] = kind === "subscribers" ? subscribersQuery.data ?? [] : generatorsQuery.data ?? [];
  const activeSite = useMemo(() => sitesQuery.data?.find((site) => site.id === siteId), [siteId, sitesQuery.data]);
  const refresh = async () => Promise.all([utils.powerhub.subscribers.list.invalidate(), utils.powerhub.subscribers.quota.invalidate(), utils.powerhub.generators.list.invalidate(), utils.powerhub.dashboard.summary.invalidate(), utils.powerhub.audit.list.invalidate()]);

  const createSubscriber = trpc.powerhub.subscribers.create.useMutation({ onSuccess: async (created) => { await refresh(); toast.success(`تمت إضافة المشترك. الرقم المرجعي: ${created.subscriberNo}`); const sent = created.referenceNotifications?.filter((item) => item.status === "submitted").length ?? 0; const failed = created.referenceNotifications?.filter((item) => item.status === "failed").length ?? 0; if (sent) toast.success(`أُرسلت رسالة الرقم المرجعي عبر ${sent} قناة مفعلة.`); else if (failed) toast.warning("سُجلت محاولة إرسال الرقم المرجعي؛ راجع سبب الفشل في سجل الإشعارات."); else toast.message("لا توجد قناة WhatsApp أو SMS مفعلة؛ الرقم المرجعي ظاهر في سجل المشتركين."); }, onError: (e) => toast.error(e.message) });
  const updateSubscriber = trpc.powerhub.subscribers.update.useMutation({ onSuccess: async () => { await refresh(); setEditing(null); toast.success("تم تحديث المشترك."); }, onError: (e) => toast.error(e.message) });
  const createGenerator = trpc.powerhub.generators.create.useMutation({ onSuccess: async () => { await refresh(); toast.success("تمت إضافة المولد."); }, onError: (e) => toast.error(e.message) });
  const updateGenerator = trpc.powerhub.generators.update.useMutation({ onSuccess: async () => { await refresh(); setEditing(null); toast.success("تم تحديث المولد."); }, onError: (e) => toast.error(e.message) });

  const submitSubscriber = (values: Values) => {
    const base = { siteId: siteId!, fullName: String(values.fullName), phone: String(values.phone), address: values.address ? String(values.address) : undefined, subscriptionType: values.subscriptionType as "residential" | "commercial", serviceStatus: values.serviceStatus as "active" | "suspended" | "disconnected" };
    if (editing) updateSubscriber.mutate({ ...base, id: editing.id });
    else createSubscriber.mutate(base);
  };
  const submitGenerator = (values: Values) => {
    if (editing) updateGenerator.mutate({ siteId: siteId!, id: editing.id, name: String(values.name), ratedCapacityKw: String(values.ratedCapacityKw), fuelLevelLiters: String(values.fuelLevelLiters), operatingHours: String(values.operatingHours), status: values.status as "active" | "maintenance" | "stopped" | "offline" });
    else createGenerator.mutate({ siteId: siteId!, code: String(values.code), name: String(values.name), serialNumber: values.serialNumber ? String(values.serialNumber) : undefined, ratedCapacityKw: String(values.ratedCapacityKw), fuelType: values.fuelType as "diesel" | "gasoline" | "gas" | "other" });
  };

  if (loading) return <DashboardLayout><Loading /></DashboardLayout>;
  if (!isAuthenticated) return <DashboardLayout><LoginPrompt title={kind === "subscribers" ? "إدارة المشتركين" : "إدارة المولدات"} /></DashboardLayout>;
  if (!sitesQuery.data?.length) return <DashboardLayout><EmptySetup /></DashboardLayout>;
  const title = kind === "subscribers" ? "المشتركون" : "المحطات والمولدات";
  const Icon = kind === "subscribers" ? UsersRound : Bolt;
  const pending = createSubscriber.isPending || updateSubscriber.isPending || createGenerator.isPending || updateGenerator.isPending;

  return <DashboardLayout><div className="space-y-6 pb-12">
    <header className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-[#111823]/80 p-5 shadow-panel sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Icon className="h-4 w-4" />إدارة الشبكة</div><h1 className="mt-1 text-2xl font-extrabold text-white">{title}</h1><p className="mt-2 text-sm text-slate-400">{kind === "subscribers" ? "إضافة وتعديل بيانات الاشتراك وحالة الخدمة." : "القدرة والوقود وساعات التشغيل والحالة اللحظية."}</p></div><select aria-label="فلتر الفرع الموحد" value={siteId ?? ""} onChange={(event) => { setSiteId(Number(event.target.value)); setEditing(null); }} className={inputClass}>{sitesQuery.data.map((site) => <option className="bg-[#111823]" value={site.id} key={site.id}>{site.name}</option>)}</select></header>
    {kind === "subscribers" ? <><SubscriberPortalGuide /><SubscriberQuotaCard quota={subscriberQuotaQuery.data} /><SubscriberFinancialOverview overview={financialOverviewQuery.data} /><SubscriberDebtorWorkspace overview={financialOverviewQuery.data} siteId={siteId!} canRemind={can(role, "manageMessaging")} /></> : null}
    <div className="grid gap-6 xl:grid-cols-[.8fr_1.2fr]">
      {canEdit ? <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5">{kind === "subscribers" ? <SubscriberEditor key={editing?.id ?? "new"} editing={editing} pending={pending} onCancel={() => setEditing(null)} onSubmit={submitSubscriber} /> : <GeneratorEditor key={editing?.id ?? "new"} editing={editing} pending={pending} onCancel={() => setEditing(null)} onSubmit={submitGenerator} />}</CardContent></Card> : <ReadOnlyCard />}
      <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="flex items-center justify-between border-b border-white/8 px-5 py-4"><h2 className="font-bold text-white">سجل {title}</h2><span className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-slate-400">{data.length} سجل</span></div><div className="p-5">{data.length ? <div className="space-y-2">{data.map((item) => <RecordRow key={item.id} kind={kind} item={item} canEdit={canEdit} onEdit={() => setEditing(item)} />)}</div> : <div className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-slate-500">لا توجد سجلات في {activeSite?.name}. {canEdit ? "استخدم النموذج لإضافة أول سجل." : ""}</div>}</div></CardContent></Card>
    </div>
  </div></DashboardLayout>;
}

function SubscriberPortalGuide() {
  return <Card className="border-sky-400/20 bg-sky-400/[.045] shadow-panel"><CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-bold text-sky-100">إرشاد بوابة الاستعلامات للمشترك</p><p className="mt-1 text-sm leading-6 text-slate-300">بعد إنشاء المشترك، استخدم زر <strong className="text-sky-100">نسخ الرقم المرجعي</strong> في بطاقته أدناه ثم شاركه معه. يفتح رابط بوابة المولد ويدخل الرقم المرجعي مع رقم هاتفه الدولي المسجل لعرض فواتيره واستهلاكه.</p></div><div className="shrink-0 rounded-xl border border-sky-300/20 bg-[#0D1117]/40 px-3 py-2 text-center text-xs text-sky-100"><span className="block font-bold">مفتاح البحث</span><span className="mt-1 block" dir="ltr">Reference No. + Phone</span></div></CardContent></Card>;
}

function SubscriberDebtorWorkspace({ overview, siteId, canRemind }: { overview: any; siteId: number; canRemind: boolean }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "overdue" | "partial" | "upcoming">("all");
  const [sort, setSort] = useState<"priority" | "balance" | "age">("priority");
  const reminder = trpc.powerhub.notifications.sendPaymentReminder.useMutation({ onSuccess: (result) => toast.success(`تم إرسال أو وضع ${result.notificationIds.length} تذكير في طابور القنوات المفعلة.`), onError: (error) => toast.error(error.message) });
  const rows = filterAndSortDebtors(overview?.topDebtors ?? [], query, status, sort);
  const statusLabel = (row: any) => row.partialInvoices ? "دفعة جزئية" : row.isOverdue ? "متأخر" : "مستحق قريباً";
  return <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between"><div><h2 className="font-bold text-white">بحث ومتابعة المتأخرات</h2><p className="mt-1 text-xs leading-5 text-slate-500">صفِّ النتائج ورتبها، ثم أرسل تذكيراً للفواتير المستحقة من القنوات المفعلة.</p></div><div className="grid w-full gap-2 sm:grid-cols-3 xl:max-w-3xl"><input aria-label="بحث المتأخرات" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="اسم المشترك أو رقم الفاتورة" className={inputClass} dir="auto" /><select aria-label="حالة المتأخرات" value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className={inputClass}><option className="bg-[#111823]" value="all">كل الحالات</option><option className="bg-[#111823]" value="overdue">متأخر</option><option className="bg-[#111823]" value="partial">دفعة جزئية</option><option className="bg-[#111823]" value="upcoming">مستحق قريباً</option></select><select aria-label="ترتيب المتأخرات" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className={inputClass}><option className="bg-[#111823]" value="priority">ترتيب الأولوية</option><option className="bg-[#111823]" value="balance">أعلى رصيد متبقٍ</option><option className="bg-[#111823]" value="age">أقدم عمر دين</option></select></div></div><div className="mt-4 overflow-x-auto">{rows.length ? <table className="w-full min-w-[760px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-3">المشترك</th><th className="pb-3">رقم الفاتورة</th><th className="pb-3">الرصيد</th><th className="pb-3">عمر الدين</th><th className="pb-3">الحالة</th><th className="pb-3"></th></tr></thead><tbody>{rows.map((row: any) => <tr className="border-t border-white/7" key={`${row.invoiceId ?? row.invoiceNo}-${row.subscriberId ?? row.subscriberNo}`}><td className="py-3 font-bold text-white">{row.subscriber}</td><td className="py-3 font-display text-xs text-[#F5B800]" dir="ltr">{row.invoiceNo ?? "—"}</td><td className="py-3 font-bold text-rose-200">{new Intl.NumberFormat("ar", { maximumFractionDigits: 2 }).format(Number(row.outstanding ?? 0))}</td><td className="py-3 text-slate-300">{row.isOverdue ? `${row.ageDays} يوم` : "غير مستحق بعد"}</td><td className="py-3"><Badge className={row.partialInvoices ? "bg-amber-400/10 text-amber-200" : row.isOverdue ? "bg-rose-400/10 text-rose-300" : "bg-sky-400/10 text-sky-200"}>{statusLabel(row)}</Badge></td><td className="py-3">{canRemind && row.invoiceId ? <Button size="sm" disabled={reminder.isPending && reminder.variables?.invoiceId === row.invoiceId} onClick={() => reminder.mutate({ siteId, invoiceId: row.invoiceId })} className="bg-[#F5B800] text-[#0D1117] hover:bg-[#ffd23f]">{reminder.isPending && reminder.variables?.invoiceId === row.invoiceId ? "جارٍ الإرسال…" : "إرسال تذكير"}</Button> : null}</td></tr>)}</tbody></table> : <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-slate-500">{query.trim() || status !== "all" ? "لا توجد متأخرات تطابق البحث أو الحالة المحددة في الفرع الحالي." : "لا توجد متأخرات ضمن النطاق الحالي."}</p>}</div>{!canRemind ? <p className="mt-4 text-xs leading-5 text-slate-500">يظهر زر التذكير للمالك أو المدير أو المحاسب المخول بإدارة المراسلات فقط.</p> : null}</CardContent></Card>;
}

function SubscriberFinancialOverview({ overview }: { overview: any }) {
  const format = (value: unknown) => new Intl.NumberFormat("ar", { maximumFractionDigits: 2 }).format(Number(value ?? 0));
  const rows = overview?.topDebtors ?? [];
  return <section className="space-y-4"><div className="grid gap-4 sm:grid-cols-3"><Card className="border-rose-400/20 bg-rose-400/[.055] shadow-panel"><CardContent className="p-5"><div className="flex items-center justify-between text-rose-200"><span className="text-sm font-bold">إجمالي الأرصدة المفتوحة</span><CircleAlert className="h-4 w-4" /></div><p className="mt-4 font-display text-3xl font-extrabold text-white">{format(overview?.outstanding.total)}</p><p className="mt-2 text-xs text-rose-100/70">عبر {format(overview?.outstanding.accountCount)} حساباً يحتاج متابعة.</p></CardContent></Card><Card className="border-amber-400/20 bg-amber-400/[.055] shadow-panel"><CardContent className="p-5"><div className="flex items-center justify-between text-amber-200"><span className="text-sm font-bold">دفعات جزئية</span><WalletCards className="h-4 w-4" /></div><p className="mt-4 font-display text-3xl font-extrabold text-white">{format(overview?.outstanding.partialInvoices)}</p><p className="mt-2 text-xs text-amber-100/70">فواتير مدفوعة جزئياً وبها رصيد متبقٍ.</p></CardContent></Card><Card className="border-sky-400/20 bg-sky-400/[.055] shadow-panel"><CardContent className="p-5"><div className="flex items-center justify-between text-sky-200"><span className="text-sm font-bold">متأخر عن الاستحقاق</span><Clock3 className="h-4 w-4" /></div><p className="mt-4 font-display text-3xl font-extrabold text-white">{format(overview?.outstanding.overdue)}</p><p className="mt-2 text-xs text-sky-100/70">أرصدة تجاوزت تاريخ الاستحقاق المحدد.</p></CardContent></Card></div><Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-0"><div className="flex items-center justify-between border-b border-white/8 px-5 py-4"><div><h2 className="font-bold text-white">المشتركون ذوو أولوية التحصيل</h2><p className="mt-1 text-xs text-slate-500">مرتبة حسب تجاوز الاستحقاق ثم قيمة الرصيد.</p></div><CircleAlert className="h-5 w-5 text-rose-300" /></div><div className="overflow-x-auto p-5">{rows.length ? <table className="w-full min-w-[580px] text-sm"><thead className="text-right text-xs text-slate-500"><tr><th className="pb-3">المشترك</th><th className="pb-3">الرقم المرجعي</th><th className="pb-3">الرصيد</th><th className="pb-3">عمر الدين</th><th className="pb-3">الحالة</th></tr></thead><tbody>{rows.map((row: any) => <tr className="border-t border-white/7" key={row.subscriberNo}><td className="py-3 font-bold text-white">{row.subscriber}</td><td className="py-3 font-display text-xs text-[#F5B800]" dir="ltr">{row.subscriberNo}</td><td className="py-3 font-bold text-rose-200">{format(row.outstanding)}</td><td className="py-3 text-slate-300">{row.isOverdue ? `${format(row.ageDays)} يوم` : "غير مستحق بعد"}</td><td className="py-3"><Badge className={row.isOverdue ? "bg-rose-400/10 text-rose-300" : "bg-amber-400/10 text-amber-200"}>{row.partialInvoices ? "دفعة جزئية" : row.isOverdue ? "متأخر" : "مستحق قريباً"}</Badge></td></tr>)}</tbody></table> : <p className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-500">لا توجد أرصدة معلقة على مشتركي الفرع حالياً.</p>}</div></CardContent></Card></section>;
}

async function copySubscriberReference(subscriberNo: string) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(subscriberNo);
    else {
      const input = document.createElement("textarea");
      input.value = subscriberNo;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(input);
      if (!copied) throw new Error("copy_failed");
    }
    toast.success(`تم نسخ الرقم المرجعي: ${subscriberNo}`);
  } catch {
    toast.error("تعذر نسخ الرقم المرجعي. انسخه يدوياً من السجل.");
  }
}

function SubscriberEditor({ editing, pending, onCancel, onSubmit }: { editing: any; pending: boolean; onCancel: () => void; onSubmit: (values: Values) => void }) {
  return <><EditorTitle text={editing ? "تعديل مشترك" : "إضافة مشترك"} editing={Boolean(editing)} onCancel={onCancel} /><form className="mt-5 space-y-4" onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); onSubmit({ fullName: String(f.get("fullName")), phone: String(f.get("phone")), address: String(f.get("address") || ""), subscriptionType: String(f.get("subscriptionType")), serviceStatus: String(f.get("serviceStatus")) }); }}><Field label="الرقم المرجعي">{editing ? <input value={editing.subscriberNo} readOnly className={`${inputClass} opacity-60`} dir="ltr" /> : <div className="rounded-xl border border-dashed border-[#F5B800]/35 bg-[#F5B800]/5 px-3 py-2.5 text-xs leading-5 text-[#F5B800]">يُولَّد تلقائياً بعد الحفظ ويظهر في رسالة التأكيد وسجل المشتركين، ليُستخدم مع رقم الهاتف في بوابة الاستعلامات.</div>}</Field><Field label="الاسم"><input required name="fullName" defaultValue={editing?.fullName} className={inputClass} /></Field><Field label="رقم الهاتف الدولي"><input required type="tel" name="phone" defaultValue={editing?.phone} placeholder="+970599000000 أو 00970599000000" className={inputClass} dir="ltr" /><p className="mt-1 text-xs leading-5 text-slate-500">يُنسّق رمز 00 تلقائياً إلى +. لا تُقبل الأرقام المحلية من دون رمز دولة حفاظاً على دقة الإرسال.</p></Field><Field label="العنوان"><input name="address" defaultValue={editing?.address ?? ""} className={inputClass} /></Field><Field label="نوع الاشتراك"><select name="subscriptionType" defaultValue={editing?.subscriptionType ?? "residential"} className={inputClass}><option value="residential">سكني</option><option value="commercial">تجاري</option></select></Field><Field label="حالة الخدمة"><select name="serviceStatus" defaultValue={editing?.serviceStatus ?? "active"} className={inputClass}><option value="active">نشط</option><option value="suspended">معلق</option><option value="disconnected">مفصول</option></select></Field><SubmitButton text={editing ? "حفظ التعديلات" : "إضافة المشترك"} pending={pending} /></form></>;
}

function GeneratorEditor({ editing, pending, onCancel, onSubmit }: { editing: any; pending: boolean; onCancel: () => void; onSubmit: (values: Values) => void }) {
  return <><EditorTitle text={editing ? "تعديل مولد" : "إضافة مولد"} editing={Boolean(editing)} onCancel={onCancel} /><form className="mt-5 space-y-4" onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); onSubmit(editing ? { name: String(f.get("name")), ratedCapacityKw: String(f.get("ratedCapacityKw")), fuelLevelLiters: String(f.get("fuelLevelLiters")), operatingHours: String(f.get("operatingHours")), status: String(f.get("status")) } : { code: String(f.get("code")), name: String(f.get("name")), serialNumber: String(f.get("serialNumber") || ""), ratedCapacityKw: String(f.get("ratedCapacityKw")), fuelType: String(f.get("fuelType")) }); }}><Field label="رمز المولد">{editing ? <input value={editing.code} readOnly className={`${inputClass} opacity-60`} dir="ltr" /> : <input required name="code" placeholder="GEN-01" className={inputClass} dir="ltr" />}</Field><Field label="الاسم"><input required name="name" defaultValue={editing?.name} className={inputClass} /></Field><Field label="القدرة kW"><input required name="ratedCapacityKw" defaultValue={editing?.ratedCapacityKw} type="number" min="1" step="0.001" className={inputClass} dir="ltr" /></Field>{editing ? <><Field label="الوقود باللتر"><input required name="fuelLevelLiters" defaultValue={editing.fuelLevelLiters} type="number" min="0" step="0.01" className={inputClass} dir="ltr" /></Field><Field label="ساعات التشغيل"><input required name="operatingHours" defaultValue={editing.operatingHours} type="number" min="0" step="0.01" className={inputClass} dir="ltr" /></Field><Field label="الحالة"><select name="status" defaultValue={editing.status} className={inputClass}><option value="active">يعمل</option><option value="maintenance">صيانة</option><option value="stopped">متوقف</option><option value="offline">غير متصل</option></select></Field></> : <><Field label="الرقم التسلسلي"><input name="serialNumber" className={inputClass} dir="ltr" /></Field><Field label="نوع الوقود"><select name="fuelType" className={inputClass}><option value="diesel">ديزل</option><option value="gasoline">بنزين</option><option value="gas">غاز</option><option value="other">آخر</option></select></Field></>}<SubmitButton text={editing ? "حفظ التعديلات" : "إضافة المولد"} pending={pending} /></form></>;
}

function RecordRow({ kind, item, canEdit, onEdit }: { kind: DirectoryKind; item: any; canEdit: boolean; onEdit: () => void }) {
  const subscriber = kind === "subscribers";
  return <div className="flex flex-col gap-3 rounded-xl border border-white/7 bg-white/[0.018] px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-bold text-white">{subscriber ? item.fullName : item.name}</p><p className="mt-1 text-xs text-slate-500">{subscriber ? `${item.subscriberNo} · ${item.phone} · ${item.subscriptionType === "commercial" ? "تجاري" : "سكني"}` : `${item.code} · ${item.ratedCapacityKw} kW · ${item.operatingHours} ساعة`}</p></div><div className="flex flex-wrap items-center gap-2">{subscriber ? <><Badge className={item.serviceStatus === "active" ? "bg-emerald-400/10 text-emerald-400" : "bg-rose-400/10 text-rose-400"}>{item.serviceStatus === "active" ? "نشط" : item.serviceStatus === "suspended" ? "معلق" : "مفصول"}</Badge><Button size="sm" variant="outline" className="border-sky-300/25 text-sky-100 hover:bg-sky-300/10 hover:text-sky-50" onClick={() => void copySubscriberReference(item.subscriberNo)}><Copy className="ml-1.5 h-3.5 w-3.5" />نسخ الرقم المرجعي</Button></> : <Badge className="bg-[#F5B800]/10 text-[#F5B800]">{item.status === "active" ? "يعمل" : item.status === "maintenance" ? "صيانة" : item.status}</Badge>}{canEdit && <Button size="icon" variant="ghost" className="h-8 w-8 text-slate-400 hover:bg-[#F5B800]/10 hover:text-[#F5B800]" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /></Button>}</div></div>;
}

function EditorTitle({ text, editing, onCancel }: { text: string; editing: boolean; onCancel: () => void }) { return <div className="flex items-center justify-between"><h2 className="font-bold text-white">{text}</h2>{editing && <Button size="sm" variant="ghost" className="text-slate-400" onClick={onCancel}>إلغاء</Button>}</div>; }
function SubmitButton({ text, pending }: { text: string; pending: boolean }) { return <Button disabled={pending} className="w-full bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><Plus className="ml-2 h-4 w-4" />{text}</Button>; }
function Loading() { return <div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div>; }
function LoginPrompt({ title }: { title: string }) { return <div className="mx-auto mt-12 max-w-xl rounded-[28px] border border-[#F5B800]/20 bg-[#111823] p-8 text-center shadow-panel"><UsersRound className="mx-auto h-8 w-8 text-[#F5B800]" /><h1 className="mt-5 text-xl font-extrabold text-white">سجّل الدخول إلى {title}</h1><p className="mt-3 leading-7 text-slate-400">يتطلب الوصول إلى بيانات الشبكة حساباً مصرحاً له.</p><Button onClick={() => startLogin()} className="mt-6 bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">تسجيل الدخول</Button></div>; }
function ReadOnlyCard() { return <Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-7 text-center text-sm leading-7 text-slate-500">أنت في وضع القراءة فقط لهذه المحطة. تواصل مع مالك المحطة أو مديرها لتفعيل صلاحية التعديل.</CardContent></Card>; }
function EmptySetup() { return <div className="mx-auto mt-12 max-w-xl rounded-[28px] border border-white/10 bg-[#111823] p-8 text-center shadow-panel"><h1 className="text-xl font-extrabold text-white">أنشئ محطة أولاً</h1><p className="mt-3 text-slate-400">المشتركون والمولدات مرتبطون بمحطة توزيع محددة.</p></div>; }
