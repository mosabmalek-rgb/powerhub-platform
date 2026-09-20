import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import PlatformAdminLayout from "@/components/PlatformAdminLayout";
import { Archive, BellRing, CalendarDays, CheckCircle2, FileText, Loader2, Megaphone, Pencil, Plus, Send, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const typeLabels: Record<string, string> = { news: "خبر", announcement: "إعلان", maintenance: "صيانة", alert: "تنبيه" };
const audienceLabels: Record<string, string> = { all: "جميع الحسابات", owner: "مالك المولد", manager: "مدير تشغيل", accountant: "محاسب", collector: "محصل", technician: "فني", viewer: "مشاهد", platform_owner: "مالك المنصة", platform_admin: "مشرف المنصة", finance_admin: "مشرف مالي" };
const statusLabels: Record<string, string> = { draft: "مسودة", scheduled: "مجدول", published: "منشور", archived: "مؤرشف" };

function dateTime(value?: string | null) {
  return value ? new Date(value).toLocaleString("ar-PS", { dateStyle: "medium", timeStyle: "short", hour12: true, timeZone: "Asia/Gaza" }) : "—";
}

export default function PlatformAnnouncementsPage() {
  const [editing, setEditing] = useState<any | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [tab, setTab] = useState("announcements");
  const list = trpc.platformAnnouncements.admin.list.useQuery();
  const utils = trpc.useUtils();
  const create = trpc.platformAnnouncements.admin.create.useMutation({ onSuccess: async () => { await utils.platformAnnouncements.admin.list.invalidate(); setShowForm(false); toast.success("تم حفظ الإعلان."); }, onError: (e) => toast.error(e.message) });
  const update = trpc.platformAnnouncements.admin.update.useMutation({ onSuccess: async () => { await utils.platformAnnouncements.admin.list.invalidate(); setEditing(null); toast.success("تم تحديث الإعلان."); }, onError: (e) => toast.error(e.message) });
  const publish = trpc.platformAnnouncements.admin.publish.useMutation({ onSuccess: async () => { await utils.platformAnnouncements.admin.list.invalidate(); toast.success("تم نشر الإعلان لجميع المستخدمين."); }, onError: (e) => toast.error(e.message) });
  const archive = trpc.platformAnnouncements.admin.archive.useMutation({ onSuccess: async () => { await utils.platformAnnouncements.admin.list.invalidate(); toast.success("تمت أرشفة الإعلان."); }, onError: (e) => toast.error(e.message) });
  const rows = list.data ?? [];

  return (
    <PlatformAdminLayout activeTab={tab} onTabChange={setTab}>
      <main className="space-y-6 pb-12" dir="rtl">
        <header className="rounded-[26px] border border-[#F5B800]/20 bg-[#111823]/85 p-6 shadow-panel">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><Megaphone className="h-4 w-4" />التواصل الداخلي</div>
              <h1 className="mt-2 text-2xl font-extrabold text-white">أخبار وإعلانات PowerHub</h1>
              <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-400">انشر خبرًا أو إعلانًا يظهر داخل المنصة لجميع المستخدمين النشطين، مع تتبع المقروء وغير المقروء.</p>
            </div>
            <Button onClick={() => { setEditing(null); setShowForm(true); }} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]"><Plus className="ml-2 h-4 w-4" />إعلان جديد</Button>
          </div>
        </header>

        {showForm || editing ? <AnnouncementForm initial={editing} pending={create.isPending || update.isPending} onCancel={() => { setShowForm(false); setEditing(null); }} onSubmit={(input) => editing ? update.mutate({ id: editing.id, ...input, type: input.type as any, audienceRoles: input.audienceRoles as any }) : create.mutate({ ...input, type: input.type as any, audienceRoles: input.audienceRoles as any, status: input.status as any, scheduledAt: input.scheduledAt || undefined })} /> : null}

        <Card className="border-white/8 bg-[#111823] shadow-panel">
          <CardContent className="p-0">
            <div className="border-b border-white/8 px-5 py-4"><h2 className="font-bold text-white">سجل الأخبار والإعلانات</h2><p className="mt-1 text-xs text-slate-500">{rows.length} سجل</p></div>
            {list.isLoading ? <div className="flex items-center gap-2 p-8 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin text-[#F5B800]" />جارٍ التحميل…</div> : rows.length ? <div className="divide-y divide-white/6">{rows.map((row) => <article key={row.id} className="p-5"><div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-extrabold text-white">{row.title}</h3><Badge className="bg-[#F5B800]/10 text-[#F5B800]">{typeLabels[row.type] ?? row.type}</Badge><Badge className={row.status === "published" ? "bg-emerald-400/10 text-emerald-300" : row.status === "archived" ? "bg-slate-500/10 text-slate-400" : "bg-amber-400/10 text-amber-200"}>{statusLabels[row.status] ?? row.status}</Badge></div><p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-300">{row.body}</p><div className="mt-3 flex flex-wrap gap-2">{(row.audienceRoles ?? ["all"]).map((role: string) => <Badge key={role} className="bg-white/5 text-slate-300">يظهر لـ: {audienceLabels[role] ?? role}</Badge>)}</div><div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-slate-500"><span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />الإنشاء: {dateTime(row.createdAt)}</span>{row.publishedAt ? <span className="inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" />النشر: {dateTime(row.publishedAt)}</span> : null}</div></div><div className="flex shrink-0 flex-wrap gap-2">{row.status !== "archived" ? <Button size="sm" variant="outline" onClick={() => setEditing(row)} className="border-white/10 text-slate-200 hover:bg-white/5"><Pencil className="ml-1 h-3.5 w-3.5" />تعديل</Button> : null}{row.status === "draft" ? <Button size="sm" onClick={() => publish.mutate({ id: row.id })} disabled={publish.isPending} className="bg-emerald-400 text-[#0D1117] hover:bg-emerald-300"><Send className="ml-1 h-3.5 w-3.5" />نشر للجميع</Button> : null}{row.status === "published" ? <Button size="sm" variant="outline" onClick={() => archive.mutate({ id: row.id })} disabled={archive.isPending} className="border-rose-400/20 text-rose-300 hover:bg-rose-400/10"><Archive className="ml-1 h-3.5 w-3.5" />أرشفة</Button> : null}</div></div></article>)}</div> : <div className="p-10 text-center text-sm text-slate-500">لا توجد أخبار أو إعلانات بعد.</div>}
          </CardContent>
        </Card>
      </main>
    </PlatformAdminLayout>
  );
}

function AnnouncementForm({ initial, pending, onCancel, onSubmit }: { initial?: any | null; pending: boolean; onCancel: () => void; onSubmit: (input: { title: string; body: string; type: string; status: string; audienceRoles: string[]; scheduledAt: string | null }) => void }) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [type, setType] = useState(initial?.type ?? "news");
  const [status, setStatus] = useState(initial ? "draft" : "draft");
  const [audienceRoles, setAudienceRoles] = useState<string[]>(initial?.audienceRoles ?? ["all"]);
  const [scheduledAt, setScheduledAt] = useState(initial?.scheduledAt ? new Date(initial.scheduledAt).toISOString().slice(0,16) : "");
  return <Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><FileText className="h-4 w-4 text-[#F5B800]" /><h2 className="font-bold text-white">{initial ? "تعديل الإعلان" : "إنشاء إعلان جديد"}</h2></div><Button size="icon" variant="ghost" onClick={onCancel} className="text-slate-400 hover:bg-white/5 hover:text-white"><X className="h-4 w-4" /></Button></div><form className="mt-5 space-y-4" onSubmit={(e) => { e.preventDefault(); onSubmit({ title, body, type, status: scheduledAt ? "scheduled" : "draft", audienceRoles, scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null }); }}><div className="grid gap-4 md:grid-cols-2"><label className="text-sm text-slate-400">العنوان<input required minLength={2} maxLength={180} value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-white/10 bg-white/[.025] px-3 text-white outline-none focus:border-[#F5B800]/70" /></label><label className="text-sm text-slate-400">النوع<select value={type} onChange={(e) => setType(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-white/10 bg-[#111823] px-3 text-white outline-none focus:border-[#F5B800]/70"><option value="news">خبر</option><option value="announcement">إعلان</option><option value="maintenance">صيانة</option><option value="alert">تنبيه</option></select></label></div><fieldset className="rounded-2xl border border-white/8 bg-white/[.018] p-4"><legend className="px-2 text-sm font-bold text-slate-300">من يرى هذا الخبر؟</legend><div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(audienceLabels).map(([value,label]) => <label key={value} className="flex items-center gap-2 rounded-xl border border-white/8 p-3 text-sm text-slate-300"><input type="checkbox" checked={audienceRoles.includes(value)} onChange={() => { if (value === "all") setAudienceRoles(["all"]); else setAudienceRoles((prev) => { const next = prev.filter((x) => x !== "all" && x !== value); return prev.includes(value) ? next : [...next, value]; }); }} />{label}</label>)}</div></fieldset><label className="text-sm text-slate-400">المحتوى<textarea required minLength={2} maxLength={10000} value={body} onChange={(e) => setBody(e.target.value)} className="mt-1 min-h-40 w-full rounded-xl border border-white/10 bg-white/[.025] p-3 text-sm leading-7 text-white outline-none focus:border-[#F5B800]/70" /></label><div className="grid gap-3 rounded-2xl border border-white/8 bg-white/[.018] p-4 md:grid-cols-[1fr_auto] md:items-end"><label className="text-sm text-slate-400">موعد النشر<label className="mt-1 flex h-11 items-center rounded-xl border border-white/10 bg-white/[.025] px-3"><input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className="w-full bg-transparent text-white outline-none" /></label></label><div className="text-xs leading-6 text-slate-500">اتركه فارغًا للمسودة. عند تحديد موعد مستقبلي سيصبح الإعلان مجدولًا ولن يظهر قبل الموعد.</div></div><div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={onCancel} className="border-white/10 text-slate-200 hover:bg-white/5">إلغاء</Button><Button disabled={pending} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">{pending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="ml-2 h-4 w-4" />}{initial ? "حفظ التعديل" : "حفظ كمسودة"}</Button></div></form></CardContent></Card>;
}
