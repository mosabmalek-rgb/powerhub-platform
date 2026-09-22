import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/lib/supabase";
import { trpc } from "@/lib/trpc";
import { listChatNotifications, subscribeToChatNotifications, subscribeToChatConversation } from "@/lib/chatReceipts";
import { Loader2, MessageCircle, RefreshCw, Send, ShieldAlert, UserRoundCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  const access = trpc.support.assertAccess.useQuery(undefined, { retry: false });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [supportUsers, setSupportUsers] = useState<SupportUser[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [input, setInput] = useState("");
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [working, setWorking] = useState(false);
  const [notificationCount, setNotificationCount] = useState(0);
  const [filter, setFilter] = useState({ status: "", priority: "", category: "", search: "" });
  const [categories, setCategories] = useState<Array<{ code: string; name: string }>>([]);
  const [internalNote, setInternalNote] = useState(false);
  const [tags, setTags] = useState<Array<{ id: number; name: string }>>([]);
  const [tagIds, setTagIds] = useState<number[]>([]);

  const selected = useMemo(() => conversations.find((conversation) => conversation.id === selectedId) ?? null, [conversations, selectedId]);
  const selectedAssignment = useMemo(() => assignments.find((assignment) => assignment.conversation_id === selectedId && ["pending", "active"].includes(assignment.status)) ?? null, [assignments, selectedId]);

  async function refreshQueue() {
    if (!access.data?.allowed) return;
    setLoadingQueue(true);
    const [queueResult, assignmentResult, userResult, categoryResult, tagResult] = await Promise.all([
      supabase.rpc("chat_support_queue", { p_status: filter.status || null, p_priority: filter.priority || null, p_category_code: filter.category || null, p_assigned_user_id: null, p_search: filter.search || null, p_limit: 100, p_offset: 0 }),
      supabase.from("chat_support_assignments").select("id,conversation_id,assigned_user_id,status"),
      supabase.rpc("chat_support_users"),
      supabase.from("chat_support_categories").select("code,name").eq("is_active", true).order("sort_order"),
      supabase.from("chat_support_tags").select("id,name").eq("is_active", true).order("name"),
    ]);
    if (queueResult.error || assignmentResult.error || userResult.error || categoryResult.error || tagResult.error) {
      toast.error("تعذر تحميل طابور الدعم."); setLoadingQueue(false); return;
    }
    setConversations((queueResult.data ?? []) as Conversation[]);
    setAssignments((assignmentResult.data ?? []) as Assignment[]);
    setSupportUsers((userResult.data ?? []) as SupportUser[]);
    setCategories((categoryResult.data ?? []) as Array<{ code: string; name: string }>);
    setTags((tagResult.data ?? []) as Array<{ id: number; name: string }>);
    setLoadingQueue(false);
    if (selectedId === null && queueResult.data?.length) setSelectedId(Number(queueResult.data[0].conversation_id));
  }
    if (!access.data?.allowed) return;
    setLoadingQueue(true);
    const [conversationResult, assignmentResult, userResult] = await Promise.all([
      supabase.from("chat_conversations").select("id,tenant_id,conversation_type,status,subject,priority,last_message_at,created_at").eq("conversation_type", "support").order("last_message_at", { ascending: false, nullsFirst: false }),
      supabase.from("chat_support_assignments").select("id,conversation_id,assigned_user_id,status"),
      supabase.rpc("chat_support_users"),
    ]);
    if (conversationResult.error || assignmentResult.error || userResult.error) {
      toast.error("تعذر تحميل طابور الدعم.");
      setLoadingQueue(false);
      return;
    }
    setConversations((conversationResult.data ?? []) as Conversation[]);
    setAssignments((assignmentResult.data ?? []) as Assignment[]);
    setSupportUsers((userResult.data ?? []) as SupportUser[]);
    setLoadingQueue(false);
    if (selectedId === null && conversationResult.data?.length) setSelectedId(conversationResult.data[0].id);
  }

  async function loadMessages(conversationId: number) {
    setLoadingMessages(true);
    const { data, error } = await supabase.from("chat_messages").select("id,conversation_id,sender_user_id,sender_type,message_type,body,visibility,created_at").eq("conversation_id", conversationId).order("created_at", { ascending: true });
    if (error) toast.error("تعذر تحميل الرسائل.");
    setMessages((data ?? []) as MessageRow[]);
    const { data: currentTags } = await supabase.from("chat_conversation_tags").select("tag_id").eq("conversation_id", conversationId);
    setTagIds((currentTags ?? []).map((row: any) => Number(row.tag_id)));
    setLoadingMessages(false);
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
    void refreshQueue();
    void listChatNotifications(100).then((rows) => setNotificationCount(rows.filter((row) => !row.read_at).length)).catch(() => undefined);
    if (!user?.id) return;
    return subscribeToChatNotifications(user.id, () => setNotificationCount((count) => count + 1));
  }, [access.data?.allowed, user?.id, filter.status, filter.priority, filter.category]);

  useEffect(() => {
    if (!selectedId) return;
    void loadMessages(selectedId);
    return subscribeToChatConversation(selectedId, () => void loadMessages(selectedId));
  }, [selectedId]);

  if (access.isLoading) return {embedded ? <div> : <DashboardLayout>}<div className="grid min-h-[70vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin" /></div></div> : </DashboardLayout>;

  if (access.error || !access.data?.allowed) {
    return <DashboardLayout><div className="mx-auto mt-16 max-w-xl rounded-2xl border border-red-200 bg-red-50 p-8 text-center"><ShieldAlert className="mx-auto mb-3 h-8 w-8 text-red-600" /><h1 className="text-xl font-bold">لا تملك صلاحية مركز الدعم</h1><p className="mt-2 text-sm text-red-700">الوصول يتطلب صلاحية المنصة manageSupportChat.</p></div></DashboardLayout>;
  }

  return (
    <DashboardLayout>
      <div className="space-y-5" dir="rtl">
        <header className="rounded-2xl border bg-background p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div><div className="flex items-center gap-2 text-sm font-bold text-primary"><MessageCircle className="h-4 w-4" />مركز دعم PowerHub</div><h1 className="mt-1 text-2xl font-extrabold">طابور الدعم الذكي</h1><p className="mt-1 text-sm text-muted-foreground">إدارة التذاكر والتصنيف والأولوية وSLA والإسناد والملاحظات الداخلية ضمن صلاحية المنصة.</p>
            <div className="mt-4 flex flex-wrap gap-2"><input value={filter.search} onChange={(e) => setFilter((x) => ({ ...x, search: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") void refreshQueue(); }} placeholder="بحث برقم التذكرة أو العميل..." className="h-9 rounded-md border bg-background px-3 text-sm" /><select value={filter.status} onChange={(e) => setFilter((x) => ({ ...x, status: e.target.value }))} className="h-9 rounded-md border bg-background px-2 text-sm"><option value="">كل الحالات</option>{["SUPPORT_PENDING","SUPPORT_ACTIVE","WAITING_USER","RESOLVED","CLOSED"].map((x) => <option key={x} value={x}>{x}</option>)}</select><select value={filter.priority} onChange={(e) => setFilter((x) => ({ ...x, priority: e.target.value }))} className="h-9 rounded-md border bg-background px-2 text-sm"><option value="">كل الأولويات</option>{["low","normal","high","urgent"].map((x) => <option key={x} value={x}>{x}</option>)}</select><select value={filter.category} onChange={(e) => setFilter((x) => ({ ...x, category: e.target.value }))} className="h-9 rounded-md border bg-background px-2 text-sm"><option value="">كل التصنيفات</option>{categories.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select></div></div>
            <div className="flex items-center gap-2"><Badge variant="outline">إشعارات غير مقروءة: {notificationCount}</Badge><Button variant="outline" size="icon" onClick={() => void refreshQueue()} disabled={loadingQueue}><RefreshCw className={`h-4 w-4 ${loadingQueue ? "animate-spin" : ""}`} /></Button></div>
          </div>
        </header>

        <div className="grid min-h-[680px] gap-4 lg:grid-cols-[330px_1fr]">
          <Card className="lg:order-1"><CardHeader><CardTitle>الطابور</CardTitle></CardHeader><CardContent className="space-y-2 px-3">
            {conversations.map((conversation) => { const assignment = assignments.find((row) => row.conversation_id === conversation.id && ["pending", "active"].includes(row.status)); return <button key={conversation.id} type="button" onClick={() => setSelectedId(conversation.id)} className={`w-full rounded-xl border p-3 text-right ${selectedId === conversation.id ? "border-primary bg-primary/5" : "border-border"}`}><div className="flex items-center justify-between gap-2"><span className="truncate font-bold">{conversation.subject || "محادثة دعم"}</span><Badge variant="secondary">{statusLabel(conversation.status)}</Badge></div><div className="mt-2 text-xs text-muted-foreground">{conversation.ticket_number || ("#" + conversation.id)} · الأولوية: {conversation.priority} · {conversation.category_name || "غير مصنف"}</div><div className="mt-1 text-[11px] text-muted-foreground">{conversation.assigned_user_name ? ("مسندة إلى " + conversation.assigned_user_name) : "غير مسندة"}{conversation.unread_count ? (" · " + conversation.unread_count + " غير مقروء") : ""}{conversation.sla_state ? (" · " + conversation.sla_state) : ""}</div></button>; })}
            {!conversations.length && <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">لا توجد محادثات دعم في الطابور.</div>}
          </CardContent></Card>

          <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle>{selected?.subject || "اختر محادثة"}</CardTitle>{selected && <div className="mt-1 text-xs text-muted-foreground">#{selected.id} · {statusLabel(selected.status)}</div>}</div>{selected && <div className="flex flex-wrap gap-2">
            <select className="h-9 rounded-md border bg-background px-2 text-sm" value={selectedAssignment?.assigned_user_id ?? ""} onChange={(event) => event.target.value && void assignConversation(Number(event.target.value))} disabled={working}><option value="">إسناد لموظف دعم</option>{supportUsers.map((supportUser) => <option key={supportUser.id} value={supportUser.id}>{supportUser.name} — {supportUser.platform_role}</option>)}</select>
            {selectedAssignment && <Button variant="outline" size="sm" onClick={() => void releaseConversation()} disabled={working}><UserRoundCheck className="ml-2 h-4 w-4" />تحرير الإسناد</Button>}
            {selected.status === "SUPPORT_ACTIVE" && <Button variant="outline" size="sm" onClick={() => void transition("WAITING_USER")} disabled={working}>انتظار المستخدم</Button>}
            {selected.status === "SUPPORT_ACTIVE" && <Button size="sm" onClick={() => void transition("RESOLVED")} disabled={working}>حل المحادثة</Button>}
            {(selected.status === "RESOLVED" || selected.status === "WAITING_USER") && <Button variant="outline" size="sm" onClick={() => void transition("SUPPORT_ACTIVE")} disabled={working}>إعادة فتح</Button>}
          </div>}</div></CardHeader>
          <CardContent>{!selected && <div className="grid min-h-[520px] place-items-center text-muted-foreground">اختر محادثة من الطابور.</div>}{selected && <div className="flex min-h-[520px] flex-col gap-3">
            <ScrollArea className="h-[430px] rounded-xl border p-4">{loadingMessages ? <div className="grid h-full place-items-center"><Loader2 className="h-6 w-6 animate-spin" /></div> : <div className="space-y-3">{messages.map((message) => <div key={message.id} className={`max-w-[80%] rounded-2xl px-4 py-3 ${message.sender_type === "system" ? "mx-auto bg-muted text-center" : message.sender_user_id === selectedAssignment?.assigned_user_id ? "ml-auto bg-primary text-primary-foreground" : "mr-auto bg-muted"}`}><div className="whitespace-pre-wrap text-sm">{message.body}</div><div className="mt-1 text-[10px] opacity-70">{new Date(message.created_at).toLocaleString("ar-PS")}</div></div>)}{!messages.length && <div className="py-10 text-center text-sm text-muted-foreground">لا توجد رسائل.</div>}</div>}</ScrollArea>
            <div className="rounded-xl border bg-muted/20 p-3"><div className="mb-2 flex items-center gap-3"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={internalNote} onChange={(e) => setInternalNote(e.target.checked)} /> ملاحظة داخلية</label><span className="text-xs text-muted-foreground">{internalNote ? "لن تظهر للعميل" : "ستظهر للعميل"}</span></div><div className="flex gap-2"><Textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder={internalNote ? "اكتب ملاحظة لفريق الدعم..." : "اكتب رد الدعم للعميل..."} className="min-h-[90px]" /><Button className="self-end" onClick={() => void sendMessage()} disabled={sending || !input.trim()}>{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</Button></div></div>
          </div>}</CardContent></Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
