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

export default function SupportCenterPage() {
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

  const selected = useMemo(() => conversations.find((conversation) => conversation.id === selectedId) ?? null, [conversations, selectedId]);
  const selectedAssignment = useMemo(() => assignments.find((assignment) => assignment.conversation_id === selectedId && ["pending", "active"].includes(assignment.status)) ?? null, [assignments, selectedId]);

  async function refreshQueue() {
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
    const { data, error } = await supabase.from("chat_messages").select("id,conversation_id,sender_user_id,sender_type,message_type,body,created_at").eq("conversation_id", conversationId).order("created_at", { ascending: true });
    if (error) toast.error("تعذر تحميل الرسائل.");
    setMessages((data ?? []) as MessageRow[]);
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
    const { data, error } = await supabase.rpc("chat_send_message", { p_conversation_id: selectedId, p_body: body, p_client_message_id: crypto.randomUUID(), p_reply_to_message_id: null });
    setSending(false);
    if (error || !data) { toast.error("تعذر إرسال الرسالة."); return; }
    setMessages((current) => [...current, data as MessageRow]);
    setInput("");
  }

  useEffect(() => {
    if (!access.data?.allowed) return;
    void refreshQueue();
    void listChatNotifications(100).then((rows) => setNotificationCount(rows.filter((row) => !row.read_at).length)).catch(() => undefined);
    if (!user?.id) return;
    return subscribeToChatNotifications(user.id, () => setNotificationCount((count) => count + 1));
  }, [access.data?.allowed, user?.id]);

  useEffect(() => {
    if (!selectedId) return;
    void loadMessages(selectedId);
    return subscribeToChatConversation(selectedId, () => void loadMessages(selectedId));
  }, [selectedId]);

  if (access.isLoading) return <DashboardLayout><div className="grid min-h-[70vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin" /></div></DashboardLayout>;

  if (access.error || !access.data?.allowed) {
    return <DashboardLayout><div className="mx-auto mt-16 max-w-xl rounded-2xl border border-red-200 bg-red-50 p-8 text-center"><ShieldAlert className="mx-auto mb-3 h-8 w-8 text-red-600" /><h1 className="text-xl font-bold">لا تملك صلاحية مركز الدعم</h1><p className="mt-2 text-sm text-red-700">الوصول يتطلب صلاحية المنصة manageSupportChat.</p></div></DashboardLayout>;
  }

  return (
    <DashboardLayout>
      <div className="space-y-5" dir="rtl">
        <header className="rounded-2xl border bg-background p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div><div className="flex items-center gap-2 text-sm font-bold text-primary"><MessageCircle className="h-4 w-4" />مركز دعم PowerHub</div><h1 className="mt-1 text-2xl font-extrabold">طابور الدعم الذكي</h1><p className="mt-1 text-sm text-muted-foreground">إدارة المحادثات والتعيين والردود وتغيير الحالة ضمن صلاحية المنصة.</p></div>
            <div className="flex items-center gap-2"><Badge variant="outline">إشعارات غير مقروءة: {notificationCount}</Badge><Button variant="outline" size="icon" onClick={() => void refreshQueue()} disabled={loadingQueue}><RefreshCw className={`h-4 w-4 ${loadingQueue ? "animate-spin" : ""}`} /></Button></div>
          </div>
        </header>

        <div className="grid min-h-[680px] gap-4 lg:grid-cols-[330px_1fr]">
          <Card className="lg:order-1"><CardHeader><CardTitle>الطابور</CardTitle></CardHeader><CardContent className="space-y-2 px-3">
            {conversations.map((conversation) => { const assignment = assignments.find((row) => row.conversation_id === conversation.id && ["pending", "active"].includes(row.status)); return <button key={conversation.id} type="button" onClick={() => setSelectedId(conversation.id)} className={`w-full rounded-xl border p-3 text-right ${selectedId === conversation.id ? "border-primary bg-primary/5" : "border-border"}`}><div className="flex items-center justify-between gap-2"><span className="truncate font-bold">{conversation.subject || "محادثة دعم"}</span><Badge variant="secondary">{statusLabel(conversation.status)}</Badge></div><div className="mt-2 text-xs text-muted-foreground">الأولوية: {conversation.priority} · {assignment ? `مسندة #${assignment.assigned_user_id}` : "غير مسندة"}</div></button>; })}
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
            <div className="flex gap-2"><Textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="اكتب رد الدعم..." className="min-h-[90px]" /><Button className="self-end" onClick={() => void sendMessage()} disabled={sending || !input.trim()}>{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</Button></div>
          </div>}</CardContent></Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
