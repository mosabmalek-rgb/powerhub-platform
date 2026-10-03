import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/lib/supabase";
import { trpc } from "@/lib/trpc";
import { Bot, Loader2, MessageCircle, RefreshCw, Send, ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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

export default function AiAssistantPage() {
  const { isAuthenticated, loading, user } = useAuth({ redirectOnUnauthenticated: true });
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [input, setInput] = useState("");
  const [loadingConversation, setLoadingConversation] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const aiRequest = trpc.aiSupport.ask.useMutation();

  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [messages],
  );

  async function loadMessages(conversationId: number) {
    setLoadingMessages(true);
    const { data, error } = await supabase
      .from("chat_messages")
      .select("id,conversation_id,sender_user_id,sender_type,message_type,body,created_at,client_message_id")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    setLoadingMessages(false);
    if (error) {
      toast.error("تعذر تحميل محادثة المساعد.");
      return;
    }

    setMessages((data ?? []) as MessageRow[]);
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth" }));
  }

  async function ensureConversation() {
    if (!user || !isAuthenticated) return;
    setLoadingConversation(true);

    const { data: memberships, error: membershipError } = await supabase
      .from("tenant_members")
      .select("tenant_id")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .eq("membership_status", "active")
      .limit(1);

    if (membershipError || !memberships?.[0]) {
      setLoadingConversation(false);
      toast.error("لم يتم العثور على مساحة عمل نشطة.");
      return;
    }

    const tenantId = Number(memberships[0].tenant_id);

    const { data: existing, error: conversationError } = await supabase
      .from("chat_conversations")
      .select("id,tenant_id,conversation_type,status,subject,priority,last_message_at,created_at")
      .eq("tenant_id", tenantId)
      .eq("conversation_type", "assistant")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    if (conversationError) {
      setLoadingConversation(false);
      toast.error("تعذر تحميل محادثة المساعد.");
      return;
    }

    if (existing) {
      const row = existing as Conversation;
      setConversation(row);
      setLoadingConversation(false);
      await loadMessages(row.id);
      return;
    }

    const { data: created, error: createError } = await supabase.rpc("chat_create_conversation", {
      p_tenant_id: tenantId,
      p_conversation_type: "assistant",
      p_subject: "مساعد PowerHub",
      p_priority: "normal",
    });

    if (createError || !created) {
      setLoadingConversation(false);
      toast.error("تعذر إنشاء مساحة المساعد.");
      return;
    }

    const row = created as Conversation;
    setConversation(row);
    setLoadingConversation(false);
    setMessages([]);
  }

  useEffect(() => {
    if (isAuthenticated && user) void ensureConversation();
  }, [isAuthenticated, user?.id]);

  useEffect(() => {
    if (!conversation?.id) return;

    const channel = supabase
      .channel("powerhub-ai-assistant-" + conversation.id)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_messages",
          filter: "conversation_id=eq." + conversation.id,
        },
        (payload) => {
          const row = payload.new as MessageRow;
          setMessages((current) => current.some((item) => item.id === row.id) ? current : [...current, row]);
          requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth" }));
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [conversation?.id]);

  async function refresh() {
    if (conversation?.id) await loadMessages(conversation.id);
  }

  async function sendMessage() {
    const body = input.trim();
    if (!body || !conversation || !user || sending) return;

    setSending(true);

    const { data: createdMessage, error: messageError } = await supabase.rpc("chat_send_message", {
      p_conversation_id: conversation.id,
      p_body: body,
      p_client_message_id: crypto.randomUUID(),
      p_reply_to_message_id: null,
    });

    if (messageError || !createdMessage) {
      setSending(false);
      toast.error("تعذر إرسال السؤال.");
      return;
    }

    const message = createdMessage as MessageRow;
    setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
    setInput("");

    try {
      const result = await aiRequest.mutateAsync({
        conversationId: conversation.id,
        messageId: message.id,
        question: body,
        tenantId: conversation.tenant_id,
        currentPage: "/ai-support",
      });

      if (result.decision === "handoff") {
        toast.info("تم تحويل الطلب إلى فريق الدعم.");
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "تعذر الحصول على رد من المساعد.";
      if (messageText.includes("غير مفعّل")) {
        toast.info("مساعد PowerHub غير مفعّل حاليًا.");
      } else {
        toast.error(messageText);
      }
      await refresh();
    } finally {
      setSending(false);
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth" }));
    }
  }

  if (loading || loadingConversation) {
    return (
      <DashboardLayout>
        <div className="grid min-h-[60vh] place-items-center">
          <Loader2 className="h-7 w-7 animate-spin text-[#F5B800]" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-5" dir="rtl">
        <header className="rounded-[24px] border border-white/8 bg-[#111823]/90 p-5 shadow-panel">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]">
                <Bot className="h-4 w-4" />
                مساعد PowerHub
              </div>
              <h1 className="mt-1 text-2xl font-extrabold text-white">المساعد الذكي</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
                أسئلة تشغيلية موثوقة من قاعدة معرفة PowerHub، مع إمكانية تحويل الطلب لفريق الدعم عند الحاجة.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge className="bg-emerald-400/10 text-emerald-300"><ShieldCheck className="ml-1 h-3.5 w-3.5" />محمي من الخادم</Badge>
              <Button type="button" variant="outline" size="icon" onClick={() => void refresh()} disabled={loadingMessages} title="تحديث المحادثة">
                <RefreshCw className={loadingMessages ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              </Button>
            </div>
          </div>
        </header>

        <Card className="border-white/8 bg-[#111823] shadow-panel">
          <CardHeader className="border-b border-white/7">
            <CardTitle className="flex items-center justify-between gap-3 text-white">
              <span className="flex items-center gap-2"><MessageCircle className="h-5 w-5 text-[#F5B800]" />محادثة المساعد</span>
              <span className="text-xs font-normal text-slate-500">لا ينفذ عمليات مالية أو إدارية</span>
            </CardTitle>
          </CardHeader>

          <ScrollArea className="h-[min(65vh,680px)] px-4 py-5">
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              {!sortedMessages.length ? (
                <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center">
                  <Bot className="mx-auto h-10 w-10 text-[#F5B800]/70" />
                  <h2 className="mt-4 text-lg font-extrabold text-white">كيف يمكنني مساعدتك؟</h2>
                  <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-500">
                    جرّب سؤالًا مثل: كيف أجدد الاشتراك؟ أو أين أجد الفواتير؟ أو كيف أتعامل مع القراءة غير المتصلة؟
                  </p>
                </div>
              ) : null}

              {sortedMessages.map((message) => {
                const mine = message.sender_type === "human" && message.sender_user_id === user?.id;
                return (
                  <div key={message.id} className={mine ? "flex justify-start" : "flex justify-end"}>
                    <div className={mine ? "max-w-[82%] rounded-2xl bg-[#F5B800] px-4 py-3 text-[#0D1117]" : "max-w-[82%] rounded-2xl bg-white/[.06] px-4 py-3 text-slate-100"}>
                      <div className="mb-1 flex items-center gap-1.5 text-[10px] opacity-70">
                        {mine ? <UserRound className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
                        <span>{mine ? "أنت" : message.sender_type === "assistant" ? "مساعد PowerHub" : "النظام"}</span>
                      </div>
                      <p className="whitespace-pre-wrap text-sm leading-6">{message.body}</p>
                      <p className="mt-1.5 text-[10px] opacity-60">
                        {new Date(message.created_at).toLocaleTimeString("ar-PS", { hour: "2-digit", minute: "2-digit" })}
                      </p>
                    </div>
                  </div>
                );
              })}

              {sending ? (
                <div className="flex justify-end">
                  <div className="flex items-center gap-2 rounded-2xl bg-white/[.06] px-4 py-3 text-sm text-slate-400">
                    <Loader2 className="h-4 w-4 animate-spin" /> جارٍ إعداد الرد الآمن...
                  </div>
                </div>
              ) : null}

              <div ref={endRef} />
            </div>
          </ScrollArea>

          <CardContent className="border-t border-white/7 p-4">
            <div className="mx-auto flex max-w-3xl items-end gap-2">
              <Textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder="اكتب سؤالك للمساعد…"
                className="min-h-12 resize-none border-white/10 bg-white/[.03] text-white"
                rows={1}
                disabled={sending}
              />
              <Button
                type="button"
                size="icon"
                onClick={() => void sendMessage()}
                disabled={!input.trim() || sending || !conversation}
                className="h-12 w-12 shrink-0 bg-[#F5B800] text-[#0D1117] hover:bg-[#ffd23f]"
                aria-label="إرسال السؤال"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
            <p className="mx-auto mt-2 max-w-3xl text-[11px] text-slate-500">
              المحتوى المرجعي وقاعدة المعرفة يعاملان كبيانات غير موثوقة وليسا أوامر للنظام.
            </p>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
