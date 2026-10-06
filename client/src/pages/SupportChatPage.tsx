import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/lib/supabase";
import { trpc } from "@/lib/trpc";
import {
  listChatMessageReceipts,
  markChatMessageDelivered,
  markChatMessageRead,
  subscribeToChatConversation,
} from "@/lib/chatReceipts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCheck, Loader2, MessageCircle, Plus, Send, ShieldQuestion, Star } from "lucide-react";
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
  first_response_due_at?: string | null;
  resolution_due_at?: string | null;
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
  if (state === "read") return <span className="font-extrabold tracking-[-0.08em] text-sky-700 dark:text-sky-300" title="✓✓ تمت القراءة" aria-label="✓✓ تمت القراءة">✓✓</span>;
  if (state === "delivered") return <span className="font-extrabold tracking-[-0.08em] text-emerald-700 dark:text-emerald-300" title="✓✓ تم التسليم" aria-label="✓✓ تم التسليم">✓✓</span>;
  return <span className="font-extrabold tracking-[-0.08em] text-slate-800 dark:text-slate-200" title="✓ أُرسلت" aria-label="✓ أُرسلت">✓</span>;
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("ar-PS", { hour: "2-digit", minute: "2-digit" });
}

export default function SupportChatPage() {
  const { isAuthenticated, loading, user } = useAuth({ redirectOnUnauthenticated: true });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedConversationIds, setSelectedConversationIds] = useState<number[]>([]);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [receipts, setReceipts] = useState<Record<number, ReceiptState>>({});
  const [input, setInput] = useState("");
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [rating, setRating] = useState(0);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [ratingSaving, setRatingSaving] = useState(false);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const archiveConversationForSelf = trpc.support.archiveConversationForSelf.useMutation();
  const endRef = useRef<HTMLDivElement>(null);
  const messageViewportRef = useRef<HTMLDivElement>(null);
  const lastMessageIdRef = useRef<number | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const playedSoundKeysRef = useRef<Set<string>>(new Set());

  const selected = useMemo(() => conversations.find((row) => row.id === selectedId) ?? null, [conversations, selectedId]);

  async function loadConversations(selectFirst = true) {
    if (!isAuthenticated || !user?.id) return;
    if (selectFirst) setLoadingConversations(true);

    const { data: participants, error: participantsError } = await supabase
      .from("chat_participants")
      .select("conversation_id")
      .eq("user_id", user.id)
      .is("left_at", null)
      .is("archived_at", null);

    if (participantsError) {
      setLoadingConversations(false);
      if (conversations.length === 0) toast.error("تعذر تحميل محادثات الدعم.");
      return;
    }

    const conversationIds = [...new Set((participants ?? []).map((row) => Number(row.conversation_id)).filter(Number.isFinite))];
    if (conversationIds.length === 0) {
      setConversations([]);
      setLoadingConversations(false);
      if (selectFirst) setSelectedId(null);
      return;
    }

    const { data, error } = await supabase
      .from("chat_conversations")
      .select("id,tenant_id,conversation_type,status,subject,priority,last_message_at,created_at,ticket_number,first_response_due_at,resolution_due_at")
      .in("id", conversationIds)
      .order("last_message_at", { ascending: false, nullsFirst: false });

    if (error) {
      setLoadingConversations(false);
      if (conversations.length === 0) toast.error("تعذر تحميل محادثات الدعم.");
      return;
    }

    const rows = (data ?? []) as Conversation[];
    setConversations(rows);
    setSelectedConversationIds((current) => current.filter((id) => rows.some((row) => row.id === id)));
    setLoadingConversations(false);
    if (selectFirst && rows.length && selectedId === null) setSelectedId(rows[0].id);
    if (selectedId !== null && !rows.some((row) => row.id === selectedId)) setSelectedId(rows[0]?.id ?? null);
  }

  function playChatAlertOnce(messageId: number | null, notificationId?: number | null) {
    const key = messageId !== null ? `message:${messageId}` : notificationId !== null && notificationId !== undefined ? `notification:${notificationId}` : null;
    if (key && playedSoundKeysRef.current.has(key)) return;
    if (key) playedSoundKeysRef.current.add(key);
    try {
      const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = audioRef.current ?? new AudioCtx();
      audioRef.current = ctx;
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.045;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + 0.12);
    } catch { /* browser audio may require prior interaction */ }
  }

  async function hydrateReceiptsBatch(messageIds: number[]) {
    if (!messageIds.length) return;
    const { data } = await supabase
      .from("chat_message_receipts")
      .select("message_id,delivered_at,read_at")
      .in("message_id", messageIds);
    const states: Record<number, ReceiptState> = {};
    for (const messageId of messageIds) {
      const rows = (data ?? []).filter((row) => Number(row.message_id) === messageId);
      states[messageId] = messageReceipt(rows);
    }
    setReceipts((current) => ({ ...current, ...states }));
  }

  function scrollMessagesToEnd(behavior: ScrollBehavior = "auto") {
    const viewport = messageViewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  }

  async function loadMessages(conversationId: number, options: { initial?: boolean; silent?: boolean } = {}) {
    if (options.initial) setLoadingMessages(true);
    const { data, error } = await supabase
      .from("chat_messages")
      .select("id,conversation_id,sender_user_id,sender_type,message_type,body,created_at,client_message_id")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    if (error) {
      if (!options.silent) {
        toast.error("تعذر تحميل رسائل المحادثة.");
        setLoadingMessages(false);
      }
      return;
    }
    const rows = (data ?? []) as MessageRow[];
    const previousLastId = lastMessageIdRef.current;
    const previousIds = new Set(messages.map((message) => message.id));
    const newlyArrivedIncoming = rows.filter((row) => !previousIds.has(row.id) && row.sender_type === "human" && row.sender_user_id !== user?.id);
    setMessages(rows);
    setMessagesLoaded(true);
    const newest = rows[rows.length - 1];
    const hasNewIncoming = newlyArrivedIncoming.length > 0 || Boolean(newest && previousLastId !== null && newest.id !== previousLastId && newest.sender_user_id !== user?.id);
    if (newlyArrivedIncoming.length > 0) {
      playChatAlertOnce(newlyArrivedIncoming[0]?.id ?? null);
      setUnreadNotificationCount((count) => count + newlyArrivedIncoming.length);
    }
    lastMessageIdRef.current = newest?.id ?? null;
    setLoadingMessages(false);
    if (!options.silent || hasNewIncoming) {
      requestAnimationFrame(() => scrollMessagesToEnd("auto"));
    }

    const incoming = rows.filter((row) => row.sender_user_id !== user?.id && row.sender_type === "human");
    if (incoming.length) {
      const latest = incoming[incoming.length - 1];
      try {
        await markChatMessageDelivered(latest.id);
        await markChatMessageRead(latest.id);
        await supabase.rpc("chat_mark_read_up_to", {
          p_conversation_id: conversationId,
          p_message_id: latest.id,
        });
      } catch {
        // Receipt updates remain best-effort; access control remains server-side.
      }
    }
  }

  useEffect(() => {
    void loadConversations();
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !user?.id) return;
    let unsubscribe: (() => void) | undefined;
    void import("@/lib/chatReceipts").then(async ({ listChatNotifications, subscribeToChatNotifications }) => {
      const rows = await listChatNotifications(20).catch(() => []);
      setUnreadNotificationCount(rows.filter((row) => !row.read_at).length);
      unsubscribe = subscribeToChatNotifications(user.id, (payload) => {
        setUnreadNotificationCount((count) => count + 1);
        playChatAlertOnce(payload.message_id ?? null, payload.notification_id);
        toast.info("وصلت رسالة دعم جديدة.");
        void loadConversations(false);
      });
    });
    return () => { unsubscribe?.(); };
  }, [isAuthenticated, user?.id]);

  useEffect(() => {
    if (selectedId === null) return;
    setMessagesLoaded(false);
    setUnreadNotificationCount(0);
    void loadMessages(selectedId, { initial: true });
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadMessages(selectedId, { silent: true });
    }, 60_000);
    return () => { window.clearInterval(timer); };
  }, [selectedId, user?.id]);

  useEffect(() => {
    if (selectedId === null) return;
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
          if (row.sender_user_id !== user?.id) playChatAlertOnce(row.id);
          requestAnimationFrame(() => scrollMessagesToEnd("smooth"));
        }
      }
      if (event.event === "chat_receipt" && event.user_id !== user?.id) {
        const next = event.read_at ? "read" : event.delivered_at ? "delivered" : "sent";
        setReceipts((current) => ({ ...current, [event.message_id]: next }));
      }
    });
  }, [selectedId, user?.id]);

  useEffect(() => {
    const outgoingIds = messages.filter((row) => row.sender_user_id === user?.id).slice(-50).map((row) => row.id);
    if (outgoingIds.length) void hydrateReceiptsBatch(outgoingIds);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && outgoingIds.length) void hydrateReceiptsBatch(outgoingIds);
    }, 30_000);
    return () => window.clearInterval(timer);
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

  async function reopenConversation() {
    if (!selectedId) return;
    const { data, error } = await supabase.rpc("chat_reopen_support_conversation", { p_conversation_id: selectedId });
    if (error || !data) {
      toast.error(error?.message === "REOPEN_WINDOW_EXPIRED" ? "انتهت مدة إعادة فتح التذكرة." : "تعذر إعادة فتح التذكرة.");
      return;
    }
    setConversations((current) => current.map((row) => row.id === selectedId ? { ...row, ...(data as Conversation) } : row));
    toast.success("تمت إعادة فتح التذكرة.");
  }

  async function rateConversation() {
    if (!selectedId || rating < 1 || rating > 5 || ratingSaving) return;
    setRatingSaving(true);
    const { error } = await supabase.rpc("chat_rate_support", { p_conversation_id: selectedId, p_rating: rating, p_comment: feedbackComment.trim() || null });
    setRatingSaving(false);
    if (error) {
      toast.error("تعذر حفظ تقييم الدعم.");
      return;
    }
    toast.success("تم تسجيل تقييمك، شكرًا لك.");
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
    requestAnimationFrame(() => scrollMessagesToEnd("smooth"));
  }

  if (loading || loadingConversations) {
    return <DashboardLayout><div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  }

  return (
    <DashboardLayout>
      <div className="flex h-[calc(100dvh-5.5rem)] min-h-0 flex-col gap-4 overflow-hidden overscroll-none" dir="rtl">
        <header className="shrink-0 rounded-[24px] border border-white/8 bg-[#111823]/90 p-5 shadow-panel">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><MessageCircle className="h-4 w-4" />الدعم الذكي</div>
              <h1 className="mt-1 text-2xl font-extrabold text-white">محادثات PowerHub</h1>
              <p className="mt-2 text-sm text-slate-400">تواصل مباشر مع الدعم، مع مؤشرات إرسال وتسليم وقراءة وإشعارات فورية.</p>
            </div>
            <div className="flex items-center gap-2"><Badge className="bg-[#F5B800]/15 text-[#F5B800]">{unreadNotificationCount ? unreadNotificationCount + " رسالة جديدة" : "لا رسائل جديدة"}</Badge><Button onClick={() => void createConversation()} disabled={creating} className="bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}محادثة دعم جديدة
            </Button></div>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 gap-4 overflow-hidden lg:grid-cols-[minmax(0,1.65fr)_minmax(300px,.85fr)]">
          <Card className="border-white/8 bg-[#111823] shadow-panel min-h-0 lg:order-2">
            <CardHeader className="py-3"><div className="flex items-center justify-between gap-2"><CardTitle className="text-base text-white">محادثاتي</CardTitle>{selectedConversationIds.length ? <Button size="sm" variant="destructive" onClick={async () => {
              if (archiveConversationForSelf.isPending) return;
              try {
                for (const conversationId of selectedConversationIds) {
                  await archiveConversationForSelf.mutateAsync({ conversationId });
                }
                const archivedIds = selectedConversationIds;
                setSelectedConversationIds([]);
                if (selectedId !== null && archivedIds.includes(selectedId)) {
                  setSelectedId(null);
                  setMessages([]);
                  setMessagesLoaded(false);
                  lastMessageIdRef.current = null;
                }
                await loadConversations(false);
                toast.success("تم حذف المحادثة من قائمتك.");
              } catch (error: any) {
                await loadConversations(false);
                toast.error(error?.message || "تعذر حذف المحادثة من قائمتك.");
              }
            }} disabled={archiveConversationForSelf.isPending}>حذف من قائمتي</Button> : null}</div></CardHeader>
            <CardContent className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 overscroll-contain">
              <div className="space-y-2">
                {conversations.map((conversation) => (
                  <div key={conversation.id} className="flex items-center gap-2"><input type="checkbox" checked={selectedConversationIds.includes(conversation.id)} onChange={(event) => { event.stopPropagation(); setSelectedConversationIds((current) => event.target.checked ? [...current, conversation.id] : current.filter((id) => id !== conversation.id)); }} aria-label="تحديد المحادثة" /><button type="button" onClick={() => setSelectedId(conversation.id)} className={`w-full rounded-xl border p-3 text-right transition ${selectedId === conversation.id ? "border-[#F5B800]/50 bg-[#F5B800]/10" : "border-white/6 bg-white/[.02] hover:bg-white/[.04]"}`}>
                    <div className="flex items-center justify-between gap-2"><span className="truncate font-bold text-white">{conversation.subject || "محادثة دعم"}</span><Badge className="bg-white/5 text-slate-300">{conversation.status === "SUPPORT_PENDING" ? "بانتظار الدعم" : conversation.status === "SUPPORT_ACTIVE" ? "نشطة" : conversation.status}</Badge></div>
                    <p className="mt-1 text-xs text-slate-500">{conversation.last_message_at ? new Date(conversation.last_message_at).toLocaleString("ar-PS") : "لا رسائل بعد"}</p>
                  </button></div>
                ))}
                {!conversations.length ? <div className="rounded-xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">لا توجد محادثات دعم بعد.</div> : null}
              </div>
            </CardContent>
          </Card>

          <Card className="min-w-0 min-h-0 overflow-hidden border-white/8 bg-[#111823] shadow-panel lg:order-1">
            {!selected ? (
              <CardContent className="grid h-full min-h-0 place-items-center p-8 text-center"><div><ShieldQuestion className="mx-auto h-10 w-10 text-[#F5B800]/70" /><h2 className="mt-4 text-xl font-extrabold text-white">اختر محادثة أو ابدأ محادثة دعم</h2><p className="mt-2 max-w-md text-sm leading-6 text-slate-400">ستظهر هنا الرسائل مع حالة الإرسال والتسليم والقراءة.</p></div></CardContent>
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <CardHeader className="border-b border-white/7"><div className="flex items-center justify-between gap-3"><div><CardTitle className="text-white">{selected.subject || "محادثة دعم"}</CardTitle><p className="mt-2 text-xs text-slate-500">التذكرة: <span className="font-mono text-slate-300">{selected.ticket_number || "#" + selected.id}</span> · الحالة: {selected.status === "SUPPORT_PENDING" ? "بانتظار الدعم" : selected.status === "SUPPORT_ACTIVE" ? "نشطة" : selected.status === "WAITING_USER" ? "بانتظار ردك" : selected.status === "RESOLVED" ? "محلولة" : selected.status === "CLOSED" ? "مغلقة" : selected.status}</p>
                {selected.first_response_due_at || selected.resolution_due_at ? <p className="mt-1 text-[11px] text-slate-500">أول استجابة: {selected.first_response_due_at ? formatTime(selected.first_response_due_at) : "—"} · موعد الحل: {selected.resolution_due_at ? formatTime(selected.resolution_due_at) : "—"}</p> : null}
                {(selected.status === "RESOLVED" || selected.status === "CLOSED") ? <div className="mt-3 flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={() => void reopenConversation()}>إعادة فتح التذكرة</Button><span className="text-[11px] text-slate-500">يمكن إعادة الفتح ضمن نافذة المتابعة.</span></div> : null}</div><Badge className="bg-emerald-400/10 text-emerald-300">Private Chat</Badge></div></CardHeader>
                <div ref={messageViewportRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5"><div className="mx-auto flex max-w-3xl flex-col gap-4">
                  {loadingMessages ? <div className="grid min-h-[420px] place-items-center"><Loader2 className="h-6 w-6 animate-spin text-[#F5B800]" /></div> : messages.map((message) => {
                    const mine = message.sender_user_id === user?.id;
                    const state = receipts[message.id] ?? "sent";
                    return <div key={message.id} className={`flex ${mine ? "justify-start" : "justify-end"}`}><div className={`max-w-[82%] rounded-2xl px-4 py-3 ${mine ? "bg-[#F5B800] text-[#0D1117]" : "bg-slate-800 text-slate-100"}`}><p className="whitespace-pre-wrap text-sm leading-6">{message.body}</p><div className={`mt-1.5 flex items-center justify-end gap-1 text-[10px] ${mine ? "text-[#0D1117]/65" : "text-slate-500"}`}><span>{formatTime(message.created_at)}</span>{mine ? <ReceiptMark state={state} /> : null}</div></div></div>;
                  })}
                  <div ref={endRef} />
                </div></div>
                {selected.status === "RESOLVED" || selected.status === "CLOSED" ? <div className="border-t border-white/7 bg-white/[.015] p-4"><div className="mx-auto max-w-3xl"><div className="flex items-center gap-2"><Star className="h-4 w-4 text-[#F5B800]" /><span className="text-sm font-bold text-white">كيف كانت تجربة الدعم؟</span></div><div className="mt-2 flex gap-1">{[1,2,3,4,5].map((value) => <button key={value} type="button" onClick={() => setRating(value)} aria-label={`تقييم ${value} من 5`} className={`rounded-md p-1 ${rating >= value ? "text-[#F5B800]" : "text-slate-600"}`}><Star className="h-5 w-5 fill-current" /></button>)}</div><Textarea value={feedbackComment} onChange={(e) => setFeedbackComment(e.target.value)} placeholder="ملاحظة اختيارية..." className="mt-2 min-h-16 border-white/10 bg-white/[.03] text-white" /><Button className="mt-2" size="sm" onClick={() => void rateConversation()} disabled={rating < 1 || ratingSaving}>{ratingSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}حفظ التقييم</Button></div></div> : null}
                <div className="border-t border-white/7 p-4"><div className="mx-auto flex max-w-3xl items-end gap-2"><Textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="اكتب رسالتك…" className="min-h-12 resize-none border-white/10 bg-white/[.03] text-white" rows={1} /><Button type="button" size="icon" onClick={() => void sendMessage()} disabled={!input.trim() || sending} className="h-12 w-12 shrink-0 bg-[#F5B800] text-[#0D1117] hover:bg-[#ffd23f]">{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</Button></div><p className="mx-auto mt-2 max-w-3xl text-[11px] text-slate-500">✓ أُرسلت · ✓✓ تم التسليم · ✓✓ تمت القراءة</p></div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}