import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/lib/supabase";
import {
  listChatMessageReceipts,
  markChatMessageDelivered,
  markChatMessageRead,
  subscribeToChatConversation,
} from "@/lib/chatReceipts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCheck, Loader2, MessageCircle, Plus, Send, ShieldQuestion } from "lucide-react";
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
  client_message_id: string | null;
};

type ReceiptState = "sent" | "delivered" | "read";

function messageReceipt(receipts: Array<{ delivered_at: string | null; read_at: string | null }>): ReceiptState {
  if (receipts.some((row) => row.read_at)) return "read";
  if (receipts.some((row) => row.delivered_at)) return "delivered";
  return "sent";
}

function ReceiptMark({ state }: { state: ReceiptState }) {
  if (state === "read") return <span className="inline-flex items-center text-sky-300" title="تمت القراءة"><CheckCheck className="h-3.5 w-3.5" /></span>;
  if (state === "delivered") return <span className="inline-flex items-center text-slate-300" title="تم التسليم"><CheckCheck className="h-3.5 w-3.5" /></span>;
  return <span className="inline-flex items-center text-slate-400" title="تم الإرسال"><Check className="h-3.5 w-3.5" /></span>;
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("ar-PS", { hour: "2-digit", minute: "2-digit" });
}

export default function SupportChatPage() {
  const { isAuthenticated, loading, user } = useAuth({ redirectOnUnauthenticated: true });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [receipts, setReceipts] = useState<Record<number, ReceiptState>>({});
  const [input, setInput] = useState("");
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => conversations.find((row) => row.id === selectedId) ?? null, [conversations, selectedId]);

  async function loadConversations(selectFirst = true) {
    if (!isAuthenticated) return;
    setLoadingConversations(true);
    const { data, error } = await supabase
      .from("chat_conversations")
      .select("id,tenant_id,conversation_type,status,subject,priority,last_message_at,created_at")
      .order("last_message_at", { ascending: false, nullsFirst: false });
    if (error) {
      setLoadingConversations(false);
      toast.error("تعذر تحميل محادثات الدعم.");
      return;
    }
    const rows = (data ?? []) as Conversation[];
    setConversations(rows);
    setLoadingConversations(false);
    if (selectFirst && rows.length && selectedId === null) setSelectedId(rows[0].id);
  }

  async function loadMessages(conversationId: number) {
    setLoadingMessages(true);
    const { data, error } = await supabase
      .from("chat_messages")
      .select("id,conversation_id,sender_user_id,sender_type,message_type,body,created_at,client_message_id")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    if (error) {
      toast.error("تعذر تحميل رسائل المحادثة.");
      setLoadingMessages(false);
      return;
    }
    const rows = (data ?? []) as MessageRow[];
    setMessages(rows);
    setLoadingMessages(false);
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth" }));

    const incoming = rows.filter((row) => row.sender_user_id !== user?.id && row.sender_type === "human");
    if (incoming.length) {
      const latest = incoming[incoming.length - 1];
      try {
        await supabase.rpc("chat_mark_read_up_to", {
          p_conversation_id: conversationId,
          p_message_id: latest.id,
        });
      } catch {
        // Read state is best-effort for UI; access control remains server-side.
      }
    }
  }

  useEffect(() => {
    void loadConversations();
  }, [isAuthenticated]);

  useEffect(() => {
    if (selectedId === null) return;
    void loadMessages(selectedId);

    return subscribeToChatConversation(selectedId, async (event) => {
      if (event.event === "chat_message") {
        const { data } = await supabase
          .from("chat_messages")
          .select("id,conversation_id,sender_user_id,sender_type,message_type,body,created_at,client_message_id")
          .eq("id", event.message_id)
          .maybeSingle();
        if (data) {
          const row = data as MessageRow;
          setMessages((current) => current.some((item) => item.id === row.id) ? current : [...current, row].sort((a, b) => a.created_at.localeCompare(b.created_at)));
          if (row.sender_user_id !== user?.id) {
            try {
              await markChatMessageDelivered(row.id);
              await markChatMessageRead(row.id);
            } catch {
              // Receipt updates are best-effort; message access remains RLS-protected.
            }
          }
          requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth" }));
        }
      }
      if (event.event === "chat_receipt" && event.user_id !== user?.id) {
        const next = event.read_at ? "read" : event.delivered_at ? "delivered" : "sent";
        setReceipts((current) => ({ ...current, [event.message_id]: next }));
      }
    });
  }, [selectedId, user?.id]);

  useEffect(() => {
    let cancelled = false;
    async function hydrateReceipts() {
      const outgoing = messages.filter((row) => row.sender_user_id === user?.id);
      const result: Record<number, ReceiptState> = {};
      for (const message of outgoing) {
        const list = await listChatMessageReceipts(message.id).catch(() => []);
        result[message.id] = messageReceipt(list);
      }
      if (!cancelled) setReceipts(result);
    }
    if (messages.length) void hydrateReceipts();
    return () => { cancelled = true; };
  }, [messages, user?.id]);

  async function createConversation() {
    if (!user || creating) return;
    setCreating(true);
    const { data: memberships, error: membershipError } = await supabase
      .from("tenant_members")
      .select("tenant_id")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .limit(1);
    if (membershipError || !memberships?.[0]) {
      setCreating(false);
      toast.error("لم يتم العثور على مساحة عمل نشطة.");
      return;
    }
    const { data, error } = await supabase.rpc("chat_create_conversation", {
      p_tenant_id: Number(memberships[0].tenant_id),
      p_conversation_type: "support",
      p_subject: "طلب دعم PowerHub",
      p_priority: "normal",
    });
    setCreating(false);
    if (error || !data) {
      toast.error("تعذر إنشاء محادثة الدعم.");
      return;
    }
    const row = data as Conversation;
    setConversations((current) => [row, ...current]);
    setSelectedId(row.id);
  }

  async function sendMessage() {
    const body = input.trim();
    if (!body || !selectedId || sending) return;
    setSending(true);
    const { data, error } = await supabase.rpc("chat_send_message", {
      p_conversation_id: selectedId,
      p_body: body,
      p_client_message_id: crypto.randomUUID(),
      p_reply_to_message_id: null,
    });
    setSending(false);
    if (error || !data) {
      toast.error("تعذر إرسال الرسالة.");
      return;
    }
    const row = data as MessageRow;
    setMessages((current) => current.some((item) => item.id === row.id) ? current : [...current, row]);
    setInput("");
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth" }));
  }

  if (loading || loadingConversations) {
    return <DashboardLayout><div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  }

  return (
    <DashboardLayout>
      <div className="space-y-5" dir="rtl">
        <header className="rounded-[24px] border border-white/8 bg-[#111823]/90 p-5 shadow-panel">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><MessageCircle className="h-4 w-4" />الدعم الذكي</div>
              <h1 className="mt-1 text-2xl font-extrabold text-white">محادثات PowerHub</h1>
              <p className="mt-2 text-sm text-slate-400">تواصل مباشر مع الدعم، مع مؤشرات إرسال وتسليم وقراءة وإشعارات فورية.</p>
            </div>
            <Button onClick={() => void createConversation()} disabled={creating} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}محادثة دعم جديدة
            </Button>
          </div>
        </header>

        <div className="grid min-h-[650px] gap-4 lg:grid-cols-[300px_1fr]">
          <Card className="border-white/8 bg-[#111823] shadow-panel lg:order-1">
            <CardHeader><CardTitle className="text-white">محادثاتي</CardTitle></CardHeader>
            <CardContent className="px-3 pb-3">
              <div className="space-y-2">
                {conversations.map((conversation) => (
                  <button key={conversation.id} type="button" onClick={() => setSelectedId(conversation.id)} className={`w-full rounded-xl border p-3 text-right transition ${selectedId === conversation.id ? "border-[#F5B800]/50 bg-[#F5B800]/10" : "border-white/6 bg-white/[.02] hover:bg-white/[.04]"}`}>
                    <div className="flex items-center justify-between gap-2"><span className="truncate font-bold text-white">{conversation.subject || "محادثة دعم"}</span><Badge className="bg-white/5 text-slate-300">{conversation.status === "SUPPORT_PENDING" ? "بانتظار الدعم" : conversation.status === "SUPPORT_ACTIVE" ? "نشطة" : conversation.status}</Badge></div>
                    <p className="mt-1 text-xs text-slate-500">{conversation.last_message_at ? new Date(conversation.last_message_at).toLocaleString("ar-PS") : "لا رسائل بعد"}</p>
                  </button>
                ))}
                {!conversations.length ? <div className="rounded-xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">لا توجد محادثات دعم بعد.</div> : null}
              </div>
            </CardContent>
          </Card>

          <Card className="min-w-0 border-white/8 bg-[#111823] shadow-panel lg:order-2">
            {!selected ? (
              <CardContent className="grid h-full min-h-[620px] place-items-center p-8 text-center"><div><ShieldQuestion className="mx-auto h-10 w-10 text-[#F5B800]/70" /><h2 className="mt-4 text-xl font-extrabold text-white">اختر محادثة أو ابدأ محادثة دعم</h2><p className="mt-2 max-w-md text-sm leading-6 text-slate-400">ستظهر هنا الرسائل مع حالة الإرسال والتسليم والقراءة.</p></div></CardContent>
            ) : (
              <div className="flex h-full min-h-[620px] flex-col">
                <CardHeader className="border-b border-white/7"><div className="flex items-center justify-between gap-3"><div><CardTitle className="text-white">{selected.subject || "محادثة دعم"}</CardTitle><p className="mt-2 text-xs text-slate-500">الحالة: {selected.status}</p></div><Badge className="bg-emerald-400/10 text-emerald-300">Private Chat</Badge></div></CardHeader>
                <ScrollArea className="flex-1 px-4 py-5"><div className="mx-auto flex max-w-3xl flex-col gap-4">
                  {loadingMessages ? <div className="grid min-h-[420px] place-items-center"><Loader2 className="h-6 w-6 animate-spin text-[#F5B800]" /></div> : messages.map((message) => {
                    const mine = message.sender_user_id === user?.id;
                    const state = receipts[message.id] ?? "sent";
                    return <div key={message.id} className={`flex ${mine ? "justify-start" : "justify-end"}`}><div className={`max-w-[82%] rounded-2xl px-4 py-3 ${mine ? "bg-[#F5B800] text-[#0D1117]" : "bg-white/[.06] text-slate-100"}`}><p className="whitespace-pre-wrap text-sm leading-6">{message.body}</p><div className={`mt-1.5 flex items-center justify-end gap-1 text-[10px] ${mine ? "text-[#0D1117]/65" : "text-slate-500"}`}><span>{formatTime(message.created_at)}</span>{mine ? <ReceiptMark state={state} /> : null}</div></div></div>;
                  })}
                  <div ref={endRef} />
                </div></ScrollArea>
                <div className="border-t border-white/7 p-4"><div className="mx-auto flex max-w-3xl items-end gap-2"><Textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="اكتب رسالتك…" className="min-h-12 resize-none border-white/10 bg-white/[.03] text-white" rows={1} /><Button type="button" size="icon" onClick={() => void sendMessage()} disabled={!input.trim() || sending} className="h-12 w-12 shrink-0 bg-[#F5B800] text-[#0D1117] hover:bg-[#ffd23f]">{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</Button></div><p className="mx-auto mt-2 max-w-3xl text-[11px] text-slate-500">✓ أُرسلت · ✓✓ تم التسليم · ✓✓ تمت القراءة</p></div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}