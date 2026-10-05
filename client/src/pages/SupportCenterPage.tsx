import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";
import { trpc } from "@/lib/trpc";
import { listChatMessageReceipts, listChatNotifications, subscribeToChatNotifications, subscribeToChatConversation, type ChatReceipt } from "@/lib/chatReceipts";
import { Check, CheckCheck, Loader2, MessageCircle, RefreshCw, Send, Settings2, ShieldAlert, Trash2, UserRoundCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

type Conversation = {
  id: number;
  tenant_id: number;
  conversation_type: "assistant" | "support";
  status: string;
  subject: string | null;
  priority: string;
  last_message_at: string | null;
  created_at: string;
  ticket_number?: string | null;
  category_code?: string | null;
  category_name?: string | null;
  assigned_user_id?: number | null;
  assigned_user_name?: string | null;
  first_response_due_at?: string | null;
  resolution_due_at?: string | null;
  sla_state?: string | null;
  unread_count?: number;
};

type MessageRow = {
  id: number;
  conversation_id: number;
  sender_user_id: number | null;
  sender_type: "human" | "assistant" | "system";
  message_type: string;
  body: string | null;
  created_at: string;
};

type Assignment = {
  id: number;
  conversation_id: number;
  assigned_user_id: number;
  status: string;
};

type SupportUser = { id: number; name: string; email: string; platform_role: string };
type ReceiptState = "sent" | "delivered" | "read";
function messageReceiptState(rows: ChatReceipt[]): ReceiptState {
  if (rows.some((row) => row.read_at)) return "read";
  if (rows.some((row) => row.delivered_at)) return "delivered";
  return "sent";
}
function ReceiptMark({ state }: { state: ReceiptState }) {
  if (state === "read") return <span className="inline-flex items-center text-sky-500" title="تمت القراءة"><CheckCheck className="h-3.5 w-3.5" /></span>;
  if (state === "delivered") return <span className="inline-flex items-center text-muted-foreground" title="تم التسليم"><CheckCheck className="h-3.5 w-3.5" /></span>;
  return <span className="inline-flex items-center text-muted-foreground" title="أُرسلت"><Check className="h-3.5 w-3.5" /></span>;
}

const priorityLabels: Record<string, string> = { low: "منخفض", normal: "عادي", high: "مرتفع", urgent: "عاجل" };

function SupportAdminControls({ data, working, onSave }: { data: any; working: boolean; onSave: (fn: string, args: Record<string, unknown>, success: string) => Promise<boolean> }) {
  const settings = data?.settings ?? {};
  const sla = data?.sla ?? [];
  const categories = data?.categories ?? [];
  const tags = data?.tags ?? [];
  const quickReplies = data?.quickReplies ?? [];
  const [autoClose, setAutoClose] = useState(Number(settings.auto_close_after_minutes ?? 2880));
  const [reopenWindow, setReopenWindow] = useState(Number(settings.reopen_window_minutes ?? 10080));
  useEffect(() => {
    setAutoClose(Number(settings.auto_close_after_minutes ?? 2880));
    setReopenWindow(Number(settings.reopen_window_minutes ?? 10080));
  }, [settings.auto_close_after_minutes, settings.reopen_window_minutes]);
  return <Card className="border-[#F5B800]/25 bg-[#111823]">
    <CardHeader><CardTitle className="text-white">إعدادات مركز الدعم</CardTitle></CardHeader>
    <CardContent className="space-y-5">
      <div className="grid gap-3 md:grid-cols-3">
        <Card className="border-white/8 bg-white/[.02]"><CardContent className="p-4"><p className="text-sm font-bold text-white">دورة التذكرة</p><div className="mt-3 grid gap-2"><label className="text-xs text-slate-400">الإغلاق التلقائي بعد الحل (دقيقة)<Input value={autoClose} onChange={(e) => setAutoClose(Number(e.target.value))} type="number" min={0} max={43200} className="mt-1 bg-black/20 text-white" /></label><label className="text-xs text-slate-400">نافذة إعادة الفتح (دقيقة)<Input value={reopenWindow} onChange={(e) => setReopenWindow(Number(e.target.value))} type="number" min={60} max={43200} className="mt-1 bg-black/20 text-white" /></label><Button disabled={working} onClick={() => void onSave("chat_support_admin_save_settings",{p_auto_close_after_minutes:autoClose,p_reopen_window_minutes:reopenWindow},"تم حفظ إعدادات دورة التذكرة.")}>حفظ</Button></div></CardContent></Card>
        <Card className="border-white/8 bg-white/[.02]"><CardContent className="p-4"><p className="text-sm font-bold text-white">سياسات SLA</p><div className="mt-3 space-y-2">{sla.map((row:any)=><div key={row.priority} className="flex items-center gap-2"><span className="w-16 text-xs text-slate-400">{priorityLabels[row.priority] ?? row.priority}</span><Input defaultValue={row.multiplier} type="number" step="0.05" min="0.05" max="10" className="bg-black/20 text-white" onBlur={(e)=>void onSave("chat_support_admin_upsert_sla",{p_priority:row.priority,p_multiplier:Number(e.target.value)},"تم تحديث SLA.")}/></div>)}</div></CardContent></Card>
        <Card className="border-white/8 bg-white/[.02]"><CardContent className="p-4"><p className="text-sm font-bold text-white">حالة النظام</p><div className="mt-3 space-y-2 text-xs text-slate-400"><p>التصنيفات: <strong className="text-white">{categories.length}</strong></p><p>الوسوم: <strong className="text-white">{tags.length}</strong></p><p>الردود الجاهزة: <strong className="text-white">{quickReplies.length}</strong></p><p>قواعد الإغلاق وإعادة الفتح مرتبطة بدورة حياة التذكرة.</p></div></CardContent></Card>
      </div>
      <details className="rounded-xl border border-white/8 bg-white/[.02] p-4"><summary className="cursor-pointer text-sm font-bold text-white">إدارة التصنيفات والوسوم والردود الجاهزة</summary>
        <div className="mt-4 grid gap-4 xl:grid-cols-3">
          <SupportCatalogEditor
            title="تصنيف دعم"
            rows={categories}
            working={working}
            fields={[
              { name: "code", label: "الكود", placeholder: "billing" },
              { name: "name", label: "الاسم", placeholder: "الفواتير" },
              { name: "first", label: "أول استجابة (دقيقة)", placeholder: "60", type: "number" },
              { name: "resolution", label: "الحل (دقيقة)", placeholder: "1440", type: "number" },
              { name: "sort", label: "الترتيب", placeholder: "100", type: "number" },
            ]}
            onSave={(value) => onSave("chat_support_admin_upsert_category", {
              p_code: value.code,
              p_name: value.name,
              p_first_response_minutes: Number(value.first || 60),
              p_resolution_minutes: Number(value.resolution || 1440),
              p_sort_order: Number(value.sort || 100),
              p_is_active: value.active,
            }, "تم حفظ تصنيف الدعم.")}
            renderRow={(row) => <div><p className="font-bold text-white">{row.name}</p><p className="text-[11px] text-slate-500">{row.code} · أول استجابة {row.default_first_response_minutes} د · حل {row.default_resolution_minutes} د</p></div>}
          />
          <SupportCatalogEditor
            title="وسم دعم"
            rows={tags}
            working={working}
            fields={[
              { name: "code", label: "الكود", placeholder: "urgent" },
              { name: "name", label: "الاسم", placeholder: "عاجل" },
              { name: "color", label: "اللون", placeholder: "#EF4444" },
            ]}
            onSave={(value) => onSave("chat_support_admin_upsert_tag", {
              p_code: value.code,
              p_name: value.name,
              p_color: value.color || "#64748B",
              p_is_active: value.active,
            }, "تم حفظ وسم الدعم.")}
            renderRow={(row) => <div><p className="font-bold text-white">{row.name}</p><p className="text-[11px] text-slate-500">{row.code} · {row.color ?? "#64748B"} · {row.is_active ? "مفعّل" : "متوقف"}</p></div>}
          />
          <SupportCatalogEditor
            title="رد جاهز"
            rows={quickReplies}
            working={working}
            fields={[
              { name: "shortcut", label: "الاختصار", placeholder: "welcome" },
              { name: "title", label: "العنوان", placeholder: "ترحيب" },
              { name: "category", label: "كود التصنيف (اختياري)", placeholder: "billing" },
              { name: "body", label: "النص", placeholder: "اكتب نص الرد الجاهز...", multiline: true },
            ]}
            onSave={(value) => onSave("chat_support_admin_upsert_quick_reply", {
              p_shortcut: value.shortcut,
              p_title: value.title,
              p_body: value.body,
              p_category_code: value.category || null,
              p_is_active: value.active,
            }, "تم حفظ الرد الجاهز.")}
            renderRow={(row) => <div><p className="font-bold text-white">{row.title}</p><p className="text-[11px] text-slate-500">{row.shortcut} · {row.category_code || "عام"} · {row.is_active ? "مفعّل" : "متوقف"}</p></div>}
          />
        </div>
        <p className="mt-4 text-xs leading-6 text-slate-500">يمكن استخدام النموذج نفسه لإضافة عنصر جديد أو تحديث عنصر موجود باستخدام الكود/الاختصار نفسه.</p>
      </details>
    </CardContent>
  </Card>;
}

function SupportCatalogEditor({ title, rows, fields, working, onSave, renderRow }: {
  title: string;
  rows: any[];
  fields: Array<{ name: string; label: string; placeholder: string; type?: string; multiline?: boolean }>;
  working: boolean;
  onSave: (value: Record<string, string | boolean>) => void;
  renderRow: (row: any) => ReactNode;
}) {
  const [active, setActive] = useState(true);
  const [values, setValues] = useState<Record<string, string>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const reset = () => { setValues({}); setActive(true); setEditingKey(null); };
  const valueFromRow = (row: any, name: string) => {
    const aliases: Record<string, string[]> = {
      first: ["first", "default_first_response_minutes"],
      resolution: ["resolution", "default_resolution_minutes"],
      sort: ["sort", "sort_order"],
      category: ["category", "category_code"],
      body: ["body", "message"],
      color: ["color"],
      code: ["code"],
      name: ["name"],
      shortcut: ["shortcut"],
      title: ["title"],
    };
    const keys = aliases[name] ?? [name];
    const match = keys.find((key) => row[key] !== undefined && row[key] !== null);
    return match ? String(row[match]) : "";
  };
  const editRow = (row: any) => {
    const key = String(row.id ?? row.code ?? row.shortcut);
    const next = Object.fromEntries(fields.map((field) => [field.name, valueFromRow(row, field.name)]));
    setValues(next);
    setActive(row.is_active !== false);
    setEditingKey(key);
  };
  return <div className="rounded-xl border border-white/8 p-3">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-bold text-white">{title}</h3>{editingKey && <Button type="button" size="sm" variant="ghost" onClick={reset} className="text-slate-400">إلغاء التعديل</Button>}</div>
    <form className="mt-3 space-y-2" onSubmit={(event) => {
      event.preventDefault();
      const normalized = Object.fromEntries(fields.map((field) => [field.name, (values[field.name] ?? "").trim()]));
      onSave({ ...normalized, active });
      reset();
    }}>
      {fields.map((field) => field.multiline
        ? <Textarea key={field.name} value={values[field.name] ?? ""} onChange={(e) => setValues((current) => ({ ...current, [field.name]: e.target.value }))} placeholder={field.placeholder} className="min-h-20 bg-black/20 text-white" />
        : <Input key={field.name} type={field.type ?? "text"} value={values[field.name] ?? ""} onChange={(e) => setValues((current) => ({ ...current, [field.name]: e.target.value }))} placeholder={field.label} className="bg-black/20 text-white" />
      )}
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />مفعّل</label>
        <Button type="submit" size="sm" disabled={working}>{working ? "جارٍ الحفظ…" : editingKey ? "حفظ التعديل" : "حفظ"}</Button>
      </div>
    </form>
    <div className="mt-4 space-y-2 max-h-52 overflow-auto">{rows.length ? rows.map((row) => {
      const key = String(row.id ?? row.code ?? row.shortcut);
      return <div key={key} className="rounded-lg border border-white/6 bg-white/[.02] p-2"><div className="flex items-start justify-between gap-2"><div className="min-w-0 flex-1">{renderRow(row)}</div><Button type="button" size="sm" variant="outline" onClick={() => editRow(row)} disabled={working} className="shrink-0 border-white/10 text-slate-200 hover:bg-white/5">تعديل</Button></div></div>;
    }) : <p className="text-xs text-slate-500">لا توجد بيانات.</p>}</div>
  </div>;
}

function AdminList({ title, rows, render }: { title:string; rows:any[]; render:(row:any)=>ReactNode }) {
  return <div className="rounded-xl border border-white/8 p-3"><h3 className="text-sm font-bold text-white">{title}</h3><div className="mt-3 space-y-2 max-h-52 overflow-auto">{rows.length ? rows.map((row) => <div key={row.id ?? row.code ?? row.shortcut} className="rounded-lg border border-white/6 bg-white/[.02] p-2">{render(row)}</div>) : <p className="text-xs text-slate-500">لا توجد بيانات.</p>}</div></div>;
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    SUPPORT_PENDING: "بانتظار الدعم",
    SUPPORT_ACTIVE: "نشطة",
    WAITING_USER: "بانتظار المستخدم",
    RESOLVED: "محلولة",
    CLOSED: "مغلقة",
  };
  return map[status] ?? status;
}

type SupportCenterPageProps = { embedded?: boolean };
export default function SupportCenterPage({ embedded = false }: SupportCenterPageProps) {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const supportOnly = user?.role === "admin" && user.platformRole === "platform_support";
  const access = trpc.support.assertAccess.useQuery(undefined, { retry: false });
  const [filter, setFilter] = useState({ status: "", priority: "", category: "", search: "" });
  const supportQueue = trpc.support.queueSnapshot.useQuery({
    status: filter.status || null,
    priority: filter.priority || null,
    category: filter.category || null,
    assignedUserId: null,
    search: filter.search.trim() || null,
    limit: 100,
    offset: 0,
  }, { enabled: access.data?.allowed === true, retry: false });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [supportUsers, setSupportUsers] = useState<SupportUser[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const deleteConversations = trpc.support.deleteConversations.useMutation();
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [receipts, setReceipts] = useState<Record<number, ReceiptState>>({});
  const [input, setInput] = useState("");
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [working, setWorking] = useState(false);
  const [notificationCount, setNotificationCount] = useState(0);
  const [categories, setCategories] = useState<Array<{ code: string; name: string }>>([]);
  const [internalNote, setInternalNote] = useState(false);
  const [tags, setTags] = useState<Array<{ id: number; name: string }>>([]);
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [adminControlsOpen, setAdminControlsOpen] = useState(false);
  const [adminControls, setAdminControls] = useState<any | null>(null);
  const [adminWorking, setAdminWorking] = useState(false);
  const [timeline, setTimeline] = useState<Array<{ id:number; event_type:string; actor_name:string|null; from_status:string|null; to_status:string|null; from_priority:string|null; to_priority:string|null; metadata:Record<string,unknown>; created_at:string }>>([]);
  const messageEndRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => conversations.find((conversation) => conversation.id === selectedId) ?? null, [conversations, selectedId]);
  const selectedAssignment = useMemo(() => assignments.find((assignment) => assignment.conversation_id === selectedId && ["pending", "active"].includes(assignment.status)) ?? null, [assignments, selectedId]);

  async function loadAdminControls() {
    const { data, error } = await supabase.rpc("chat_support_admin_snapshot");
    if (!error && data) setAdminControls(data);
  }

  async function refreshQueue(options: { silent?: boolean } = {}) {
    if (!access.data?.allowed) return;
    if (!options.silent) setLoadingQueue(true);
    const { data, error } = await supportQueue.refetch();
    if (error || !data) {
      toast.error(error?.message || "تعذر تحميل طابور الدعم.");
      setLoadingQueue(false);
      return;
    }
    const rows = (data.conversations ?? []).map((row: any) => ({ ...row, id: Number(row.conversation_id) })) as Conversation[];
    setConversations(rows);
    setAssignments((data.assignments ?? []) as Assignment[]);
    setSupportUsers((data.supportUsers ?? []) as SupportUser[]);
    setCategories((data.categories ?? []) as Array<{ code: string; name: string }>);
    setTags((data.tags ?? []) as Array<{ id: number; name: string }>);
    setLoadingQueue(false);
    if (adminControlsOpen) await loadAdminControls();
    if (selectedId === null && rows.length) setSelectedId(rows[0].id);
    if (selectedId !== null && !rows.some((row) => row.id === selectedId)) setSelectedId(rows[0]?.id ?? null);
  }

  function toggleConversationSelection(id: number) {
    setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  async function deleteSelectedConversations() {
    if (!selectedIds.length || deleteConversations.isPending) return;
    if (!window.confirm(`سيتم حذف ${selectedIds.length} محادثة/محادثات نهائيًا مع تسجيل العملية في سجل التدقيق. هل تريد المتابعة؟`)) return;
    try {
      const result = await deleteConversations.mutateAsync({ conversationIds: selectedIds });
      setSelectedIds([]);
      if (selectedId && selectedIds.includes(selectedId)) {
        setSelectedId(null);
        setMessages([]);
      }
      toast.success(`تم حذف ${result.deletedCount} محادثة.`);
      await refreshQueue();
    } catch (error: any) {
      toast.error(error?.message || "تعذر حذف المحادثات.");
    }
  }

  async function loadMessages(conversationId: number, options: { silent?: boolean } = {}) {
    if (!options.silent) setLoadingMessages(true);
    const { data, error } = await supabase.from("chat_messages").select("id,conversation_id,sender_user_id,sender_type,message_type,body,visibility,created_at").eq("conversation_id", conversationId).order("created_at", { ascending: true });
    if (error) toast.error("تعذر تحميل الرسائل.");
    const loadedMessages = (data ?? []) as MessageRow[];
    setMessages(loadedMessages);
    const receiptEntries = await Promise.all(loadedMessages.map(async (message) => {
      if (message.sender_user_id !== user?.id && message.sender_type !== "human") return [message.id, "sent" as ReceiptState] as const;
      const rows = await listChatMessageReceipts(message.id).catch(() => []);
      return [message.id, messageReceiptState(rows)] as const;
    }));
    setReceipts(Object.fromEntries(receiptEntries));
    const incoming = loadedMessages.filter((message) => message.sender_type === "human" && message.sender_user_id !== user?.id);
    if (incoming.length) {
      const latest = incoming[incoming.length - 1];
      try {
        await supabase.rpc("chat_mark_delivered", { p_message_id: latest.id });
        await supabase.rpc("chat_mark_read", { p_message_id: latest.id });
      } catch {
        // Receipt updates remain best-effort.
      }
    }
    const { data: currentTags } = await supabase.from("chat_conversation_tags").select("tag_id").eq("conversation_id", conversationId);
    setTagIds((currentTags ?? []).map((row: any) => Number(row.tag_id)));
    const { data: timelineData } = await supabase.rpc("chat_ticket_timeline", { p_conversation_id: conversationId });
    setTimeline((timelineData ?? []) as typeof timeline);
    setLoadingMessages(false);
    requestAnimationFrame(() => messageEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" }));
  }

  async function saveAdminRpc(fn: string, args: Record<string, unknown>, success: string) {
    setAdminWorking(true);
    const { error } = await supabase.rpc(fn, args);
    setAdminWorking(false);
    if (error) { toast.error(error.message || "تعذر حفظ إعداد الدعم."); return false; }
    toast.success(success);
    await refreshQueue();
    return true;
  }

  async function assignConversation(userId: number) {
    if (!selectedId) return;
    setWorking(true);
    const { error } = await supabase.rpc("chat_assign_support", { p_conversation_id: selectedId, p_assigned_user_id: userId });
    setWorking(false);
    if (error) { toast.error("تعذر إسناد المحادثة."); return; }
    toast.success("تم إسناد المحادثة.");
    await refreshQueue();
  }

  async function releaseConversation() {
    if (!selectedId) return;
    setWorking(true);
    const { error } = await supabase.rpc("chat_release_support", { p_conversation_id: selectedId });
    setWorking(false);
    if (error) { toast.error("تعذر إلغاء الإسناد."); return; }
    toast.success("تم تحرير المحادثة.");
    await refreshQueue();
  }

  async function transition(nextStatus: string) {
    if (!selectedId) return;
    setWorking(true);
    const { error } = await supabase.rpc("chat_transition_conversation", { p_conversation_id: selectedId, p_next_status: nextStatus });
    setWorking(false);
    if (error) { toast.error("تعذر تغيير حالة المحادثة."); return; }
    await refreshQueue();
  }

  async function sendMessage() {
    const body = input.trim();
    if (!body || !selectedId || sending) return;
    setSending(true);
    const rpc = internalNote ? "chat_send_internal_note" : "chat_send_message";
    const args = internalNote ? { p_conversation_id: selectedId, p_body: body, p_client_message_id: crypto.randomUUID() } : { p_conversation_id: selectedId, p_body: body, p_client_message_id: crypto.randomUUID(), p_reply_to_message_id: null };
    const { data, error } = await supabase.rpc(rpc, args);
    setSending(false);
    if (error || !data) { toast.error("تعذر إرسال الرسالة."); return; }
    setMessages((current) => [...current, data as MessageRow]);
    setInput("");
    setInternalNote(false);
    await refreshQueue();
  }

  useEffect(() => {
    if (!access.data?.allowed) return;
    void refreshQueue({ silent: true });
    void listChatNotifications(100).then((rows) => setNotificationCount(rows.filter((row) => !row.read_at).length)).catch(() => undefined);
    if (!user?.id) return;
    return subscribeToChatNotifications(user.id, () => setNotificationCount((count) => count + 1));
  }, [access.data?.allowed, user?.id, filter.status, filter.priority, filter.category]);

  useEffect(() => {
    if (!selectedId) return;
    void loadMessages(selectedId);
    const unsubscribe = subscribeToChatConversation(selectedId, async (event) => {
      if (event.event === "chat_receipt") {
        const rows = await listChatMessageReceipts(event.message_id).catch(() => []);
        setReceipts((current) => ({ ...current, [event.message_id]: messageReceiptState(rows) }));
      } else {
        await loadMessages(selectedId, { silent: true });
      }
    });
    const timer = window.setInterval(() => { void loadMessages(selectedId, { silent: true }); }, 5000);
    return () => { unsubscribe(); window.clearInterval(timer); };
  }, [selectedId]);

  if (access.isLoading) return <div className="grid min-h-[55vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin" /></div>;

  if (access.error || !access.data?.allowed) {
    return <DashboardLayout><div className="mx-auto mt-16 max-w-xl rounded-2xl border border-red-200 bg-red-50 p-8 text-center"><ShieldAlert className="mx-auto mb-3 h-8 w-8 text-red-600" /><h1 className="text-xl font-bold">لا تملك صلاحية مركز الدعم</h1><p className="mt-2 text-sm text-red-700">الوصول يتطلب صلاحية المنصة manageSupportChat.</p></div></DashboardLayout>;
  }

  const content = <div className="space-y-5" dir="rtl">
        <header className="rounded-2xl border bg-background p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div><div className="flex items-center gap-2 text-sm font-bold text-primary"><MessageCircle className="h-4 w-4" />مركز دعم PowerHub</div><h1 className="mt-1 text-2xl font-extrabold">طابور الدعم الذكي</h1><p className="mt-1 text-sm text-muted-foreground">إدارة التذاكر والتصنيف والأولوية وSLA والإسناد والملاحظات الداخلية ضمن صلاحية المنصة.</p>
            <div className="mt-4 flex flex-wrap gap-2"><input value={filter.search} onChange={(e) => setFilter((x) => ({ ...x, search: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") void refreshQueue(); }} placeholder="بحث برقم التذكرة أو العميل..." className="h-9 rounded-md border bg-background px-3 text-sm" /><select value={filter.status} onChange={(e) => setFilter((x) => ({ ...x, status: e.target.value }))} className="h-9 rounded-md border bg-background px-2 text-sm"><option value="">كل الحالات</option>{["SUPPORT_PENDING","SUPPORT_ACTIVE","WAITING_USER","RESOLVED","CLOSED"].map((x) => <option key={x} value={x}>{x}</option>)}</select><select value={filter.priority} onChange={(e) => setFilter((x) => ({ ...x, priority: e.target.value }))} className="h-9 rounded-md border bg-background px-2 text-sm"><option value="">كل الأولويات</option>{["low","normal","high","urgent"].map((x) => <option key={x} value={x}>{x}</option>)}</select><select value={filter.category} onChange={(e) => setFilter((x) => ({ ...x, category: e.target.value }))} className="h-9 rounded-md border bg-background px-2 text-sm"><option value="">كل التصنيفات</option>{categories.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select></div></div>
            <div className="flex items-center gap-2"><Badge variant="outline">إشعارات غير مقروءة: {notificationCount}</Badge>
          {!supportOnly && <Button variant="outline" size="sm" onClick={() => { setAdminControlsOpen((open) => !open); if (!adminControls) void loadAdminControls(); }}><Settings2 className="ml-2 h-4 w-4" />إعدادات الدعم</Button>}<Button variant="outline" size="icon" onClick={() => void refreshQueue()} disabled={loadingQueue}><RefreshCw className={`h-4 w-4 ${loadingQueue ? "animate-spin" : ""}`} /></Button></div>
          </div>
        </header>

        <div className="grid min-h-[760px] gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(300px,.85fr)]">
          <Card className="min-h-0 lg:order-2"><CardHeader><div className="flex items-center justify-between gap-2"><CardTitle>الطابور</CardTitle>{selectedIds.length ? <Button size="sm" variant="destructive" onClick={() => void deleteSelectedConversations()} disabled={deleteConversations.isPending}><Trash2 className="ml-2 h-4 w-4" />حذف المحدد ({selectedIds.length})</Button> : null}</div></CardHeader><CardContent className="space-y-2 px-3 max-h-[680px] overflow-y-auto">
            {conversations.map((conversation) => { const assignment = assignments.find((row) => row.conversation_id === conversation.id && ["pending", "active"].includes(row.status)); return <div key={conversation.id} className={`flex items-stretch gap-2 rounded-xl border p-2 ${selectedId === conversation.id ? "border-primary bg-primary/5" : "border-border"}`}><input aria-label={`تحديد المحادثة ${conversation.id}`} type="checkbox" checked={selectedIds.includes(conversation.id)} onChange={() => toggleConversationSelection(conversation.id)} className="mt-1 h-4 w-4 shrink-0" /><button type="button" onClick={() => setSelectedId(conversation.id)} className="min-w-0 flex-1 text-right"><div className="flex items-center justify-between gap-2"><span className="truncate font-bold">{conversation.subject || "محادثة دعم"}</span><Badge variant="secondary">{statusLabel(conversation.status)}</Badge></div><div className="mt-2 text-xs text-muted-foreground">{conversation.ticket_number || ("#" + conversation.id)} · الأولوية: {conversation.priority} · {conversation.category_name || "غير مصنف"}</div><div className="mt-1 text-[11px] text-muted-foreground">{conversation.assigned_user_name ? ("مسندة إلى " + conversation.assigned_user_name) : "غير مسندة"}{conversation.unread_count ? (" · " + conversation.unread_count + " غير مقروء") : ""}{conversation.sla_state ? (" · " + conversation.sla_state) : ""}</div></button></div>; })}
            {!conversations.length && <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">لا توجد محادثات دعم في الطابور.</div>}
          </CardContent></Card>

          <Card className="min-w-0 lg:order-1"><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle>{selected?.subject || "اختر محادثة"}</CardTitle>{selected && <div className="mt-1 text-xs text-muted-foreground">#{selected.id} · {statusLabel(selected.status)}</div>}</div>{selected && <div className="flex flex-wrap gap-2">
            <select className="h-9 rounded-md border bg-background px-2 text-sm" value={selectedAssignment?.assigned_user_id ?? ""} onChange={(event) => event.target.value && void assignConversation(Number(event.target.value))} disabled={working}><option value="">إسناد لموظف دعم</option>{supportUsers.map((supportUser) => <option key={supportUser.id} value={supportUser.id}>{supportUser.name} — {supportUser.platform_role}</option>)}</select>
            {selectedAssignment && <Button variant="outline" size="sm" onClick={() => void releaseConversation()} disabled={working}><UserRoundCheck className="ml-2 h-4 w-4" />تحرير الإسناد</Button>}
            {selected.status === "SUPPORT_ACTIVE" && <Button variant="outline" size="sm" onClick={() => void transition("WAITING_USER")} disabled={working}>انتظار المستخدم</Button>}
            {selected.status === "SUPPORT_ACTIVE" && <Button size="sm" onClick={() => void transition("RESOLVED")} disabled={working}>حل المحادثة</Button>}
            {(selected.status === "RESOLVED" || selected.status === "WAITING_USER") && <Button variant="outline" size="sm" onClick={() => void transition("SUPPORT_ACTIVE")} disabled={working}>إعادة فتح</Button>}
          </div>}</div></CardHeader>
          <CardContent>{!selected && <div className="grid min-h-[520px] place-items-center text-muted-foreground">اختر محادثة من الطابور.</div>}{selected && <div className="flex min-h-[520px] flex-col gap-3">
            <div className="rounded-xl border bg-muted/20 p-3">
              <div className="mb-2 text-xs font-bold">السجل الزمني للتذكرة</div>
              <ScrollArea className="h-32"><div className="space-y-2 text-xs">
                {timeline.map((event) => <div key={event.id} className="flex items-start gap-2 border-b pb-2 last:border-0">
                  <span className="font-medium">{event.event_type}</span>
                  <span className="text-muted-foreground">{event.actor_name || "النظام"}</span>
                  <span className="mr-auto text-muted-foreground">{new Date(event.created_at).toLocaleString("ar-PS")}</span>
                </div>)}
                {!timeline.length && <div className="py-3 text-center text-muted-foreground">لا توجد أحداث مسجلة.</div>}
              </div></ScrollArea>
            </div>
            <ScrollArea className="h-[430px] min-h-0 rounded-xl border p-4">{loadingMessages ? <div className="grid h-full place-items-center"><Loader2 className="h-6 w-6 animate-spin" /></div> : <div className="space-y-3">{messages.map((message) => { const mine = message.sender_user_id === user?.id && message.sender_type === "human"; const incoming = message.sender_type === "human" && !mine; return <div key={message.id} className={`flex ${mine ? "justify-start" : incoming ? "justify-end" : "justify-center"}`}><div className={`max-w-[86%] rounded-2xl px-4 py-3 ${message.sender_type === "system" ? "bg-muted text-center text-foreground" : mine ? "bg-primary text-primary-foreground" : "border border-border bg-card text-card-foreground"}`}><div className="whitespace-pre-wrap text-sm leading-6">{message.body}</div><div className="mt-1 flex items-center justify-end gap-1 text-[10px] opacity-80"><span>{new Date(message.created_at).toLocaleString("ar-PS")}</span>{mine ? <ReceiptMark state={receipts[message.id] ?? "sent"} /> : null}</div></div></div>; })}{!messages.length && <div className="py-10 text-center text-sm text-muted-foreground">لا توجد رسائل.</div>}</div>}<div ref={messageEndRef} /></ScrollArea>
            <div className="rounded-xl border bg-muted/20 p-3"><div className="mb-2 flex items-center gap-3"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={internalNote} onChange={(e) => setInternalNote(e.target.checked)} /> ملاحظة داخلية</label><span className="text-xs text-muted-foreground">{internalNote ? "لن تظهر للعميل" : "ستظهر للعميل"}</span></div><div className="flex gap-2"><Textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder={internalNote ? "اكتب ملاحظة لفريق الدعم..." : "اكتب رد الدعم للعميل..."} className="min-h-[90px]" /><Button className="self-end" onClick={() => void sendMessage()} disabled={sending || !input.trim()}>{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</Button></div></div>
          </div>}</CardContent></Card>
        </div>
      </div>;
  return embedded ? content : <DashboardLayout>{content}</DashboardLayout>;
}
