import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { BellRing, Volume2, VolumeX, MessageSquareText, Megaphone, Check, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { trpc } from "@/lib/trpc";
import { listChatNotifications, markChatNotificationRead, subscribeToChatNotifications, type ChatInboxNotification } from "@/lib/chatReceipts";

const SOUND_KEY = "powerhub.notification-sound-muted.v1";

export function NotificationCenter({ userId }: { userId: number }) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [muted, setMuted] = useState(() => {
    try { return window.localStorage.getItem(SOUND_KEY) === "1"; } catch { return false; }
  });
  const chatQuery = useQuery({
    queryKey: ["notification-center", "chat", userId],
    queryFn: () => listChatNotifications(20),
    enabled: Boolean(userId),
    staleTime: 15000,
    refetchOnWindowFocus: true,
  });
  const announcementsQuery = trpc.platformAnnouncements.inbox.list.useQuery(undefined, {
    enabled: Boolean(userId),
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
  });
  const markAnnouncementRead = trpc.platformAnnouncements.inbox.markRead.useMutation({
    onSuccess: () => void announcementsQuery.refetch(),
    onError: (error) => toast.error(error.message),
  });
  const latestChat = chatQuery.data ?? [];
  const latestAnnouncements = (announcementsQuery.data ?? []).slice(0, 20);
  const unreadChat = latestChat.filter((item) => !item.read_at).length;
  const unreadAnnouncements = latestAnnouncements.filter((item) => !item.readAt).length;
  const unreadTotal = unreadChat + unreadAnnouncements;
  const items = useMemo(() => [
    ...latestChat.map((item) => ({ kind: "chat" as const, id: item.id, createdAt: item.created_at, read: Boolean(item.read_at), title: item.title, body: item.body ?? "لديك رسالة جديدة في الدردشة.", row: item })),
    ...latestAnnouncements.map((item) => ({ kind: "announcement" as const, id: item.id, createdAt: item.publishedAt, read: Boolean(item.readAt), title: item.title, body: item.body, row: item })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 8), [latestChat, latestAnnouncements]);
  const seenIds = useRef<Set<number> | null>(null);

  useEffect(() => {
    if (!userId) return;
    const unsubscribe = subscribeToChatNotifications(userId, (event) => {
      seenIds.current ??= new Set<number>();
      if (seenIds.current.has(event.notification_id)) return;
      seenIds.current.add(event.notification_id);
      void queryClient.invalidateQueries({ queryKey: ["notification-center", "chat", userId] });
      if (!muted) {
        try {
          const Ctx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (Ctx) {
            const ctx = new Ctx();
            const oscillator = ctx.createOscillator();
            const gain = ctx.createGain();
            oscillator.frequency.value = 740;
            gain.gain.value = 0.035;
            oscillator.connect(gain);
            gain.connect(ctx.destination);
            oscillator.start();
            oscillator.stop(ctx.currentTime + 0.11);
            oscillator.onended = () => void ctx.close();
          }
        } catch { /* Notifications remain available when audio is blocked. */ }
      }
      toast.info("وصل إشعار جديد في الدردشة والدعم.", { duration: 3500 });
    });
    return unsubscribe;
  }, [userId, queryClient, muted]);

  useEffect(() => {
    if (!chatQuery.data) return;
    const ids = new Set(chatQuery.data.map((item) => item.id));
    if (seenIds.current === null) { seenIds.current = ids; return; }
    seenIds.current = new Set([...seenIds.current, ...ids]);
  }, [chatQuery.data]);

  const toggleSound = () => {
    const next = !muted;
    setMuted(next);
    try { window.localStorage.setItem(SOUND_KEY, next ? "1" : "0"); } catch { /* optional preference */ }
  };

  const openItem = async (item: (typeof items)[number]) => {
    if (item.kind === "chat") {
      const row = item.row as ChatInboxNotification;
      if (!row.read_at) {
        try {
          await markChatNotificationRead(row.id);
          await queryClient.invalidateQueries({ queryKey: ["notification-center", "chat", userId] });
        } catch (error) { toast.error(error instanceof Error ? error.message : "تعذر تحديث حالة الإشعار."); }
      }
      setLocation("/support-chat");
      return;
    }
    const row = item.row as { id: number; readAt: string | null };
    if (!row.readAt) markAnnouncementRead.mutate({ id: row.id });
    setLocation("/announcements");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`الإشعارات، ${unreadTotal} غير مقروء`} className="relative flex h-9 w-9 items-center justify-center rounded-lg text-slate-300 hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5B800]">
          <BellRing className="h-4 w-4" />
          {unreadTotal > 0 ? <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-rose-500 px-1 text-[9px] font-extrabold leading-4 text-white">{unreadTotal > 99 ? "99+" : unreadTotal}</span> : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(22rem,calc(100vw-1rem))] border-white/10 bg-[#1b222c] text-white">
        <div className="flex items-center justify-between gap-2 border-b border-white/8 px-3 py-3">
          <div><p className="font-bold">الإشعارات</p><p className="mt-1 text-xs text-slate-400">{unreadTotal} غير مقروء</p></div>
          <button type="button" aria-label={muted ? "تشغيل صوت الإشعارات" : "كتم صوت الإشعارات"} title={muted ? "تشغيل الصوت" : "كتم الصوت"} onClick={toggleSound} className="grid h-8 w-8 place-items-center rounded-lg text-slate-300 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5B800]">{muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}</button>
        </div>
        {chatQuery.isLoading || announcementsQuery.isLoading ? <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />جارٍ تحميل الإشعارات…</div> : null}
        {chatQuery.isError || announcementsQuery.isError ? <div className="px-4 py-5 text-sm text-rose-300">تعذر تحميل بعض الإشعارات. <button type="button" onClick={() => { void chatQuery.refetch(); void announcementsQuery.refetch(); }} className="underline">إعادة المحاولة</button></div> : null}
        {!chatQuery.isLoading && !announcementsQuery.isLoading && items.length === 0 ? <div className="px-4 py-8 text-center text-sm text-slate-400">لا توجد إشعارات حتى الآن.</div> : null}
        {items.map((item) => <DropdownMenuItem key={`${item.kind}:${item.id}`} onSelect={(event) => { event.preventDefault(); void openItem(item); }} className={`cursor-pointer items-start gap-2 whitespace-normal px-3 py-3 focus:bg-white/5 ${item.read ? "opacity-75" : "bg-white/[.035]"}`}>
          <span className="mt-0.5 rounded-md bg-white/5 p-1.5">{item.kind === "chat" ? <MessageSquareText className="h-4 w-4 text-sky-300" /> : <Megaphone className="h-4 w-4 text-[#F5B800]" />}</span>
          <span className="min-w-0 flex-1"><span className="block font-semibold">{item.title}</span><span className="mt-1 block line-clamp-2 text-xs leading-5 text-slate-400">{item.body}</span><span className="mt-1 block text-[10px] text-slate-500">{new Date(item.createdAt).toLocaleString("ar-PS", { dateStyle: "short", timeStyle: "short" })}</span></span>
          {item.read ? <Check className="mt-1 h-3.5 w-3.5 text-emerald-300" /> : null}
        </DropdownMenuItem>)}
        <DropdownMenuSeparator className="bg-white/10" />
        <DropdownMenuItem onSelect={() => setLocation("/announcements")} className="cursor-pointer justify-between text-sm focus:bg-white/5">عرض جميع الإعلانات <ExternalLink className="h-3.5 w-3.5" /></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
