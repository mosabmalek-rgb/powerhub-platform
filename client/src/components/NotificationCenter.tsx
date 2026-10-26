import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { BellRing, Volume2, VolumeX, MessageSquareText, Megaphone, Check, ExternalLink, Loader2, ClipboardList } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { trpc } from "@/lib/trpc";
import { listChatNotifications, markChatNotificationRead, subscribeToChatNotifications, type ChatInboxNotification } from "@/lib/chatReceipts";
import { supabase } from "@/lib/supabase";

const SOUND_KEY = "powerhub.notification-sound-muted.v1";
const EVENT_QUERY_KEY = ["notification-center", "events"] as const;
const UNREAD_QUERY_KEY = ["notification-center", "unread-count"] as const;
type StoredNotification = { id:number; user_id:number; tenant_id:number|null; notification_type:string; title:string; body:string; target_path:string; entity_type:string|null; entity_id:string|null; dedupe_key:string; metadata:Record<string,unknown>; read_at:string|null; created_at:string };
type CenterItem = { kind:"chat"|"announcement"|"event"; id:number|string; createdAt:string; read:boolean; title:string; body:string; targetPath:string; row:unknown };

export function NotificationCenter({ userId, enabled = true }: { userId: number; enabled?: boolean }) {
  const active = enabled && Boolean(userId);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [muted, setMuted] = useState(() => { try { return window.localStorage.getItem(SOUND_KEY) === "1"; } catch { return false; } });
  const [markVisiblePending, setMarkVisiblePending] = useState(false);
  const mutedRef = useRef(muted);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  const chatQuery = useQuery({ queryKey:["notification-center","chat",userId], queryFn:()=>listChatNotifications(20), enabled:active, staleTime:0, refetchInterval:15000, refetchOnWindowFocus:true });
  const chatUnreadQuery = useQuery({queryKey:["notification-center","chat-unread",userId],queryFn:async()=>{const {data,error}=await supabase.rpc("chat_unread_notification_count");if(error)throw error;return Number(data??0);},enabled:active,staleTime:0,refetchInterval:15000,refetchOnWindowFocus:true});
  const eventQuery = useQuery({ queryKey:[...EVENT_QUERY_KEY,userId], queryFn:async()=>{const {data,error}=await supabase.rpc("powerhub_notification_list",{p_limit:50});if(error)throw error;return (data??[]) as StoredNotification[];},enabled:active,staleTime:0,refetchInterval:15000,refetchOnWindowFocus:true });
  const unreadQuery = useQuery({queryKey:[...UNREAD_QUERY_KEY,userId],queryFn:async()=>{const {data,error}=await supabase.rpc("powerhub_notification_unread_count");if(error)throw error;return Number(data??0);},enabled:active,staleTime:0,refetchInterval:15000,refetchOnWindowFocus:true});
  const announcementsQuery = trpc.platformAnnouncements.inbox.list.useQuery(undefined,{enabled:active,staleTime:0,refetchInterval:15000,refetchOnWindowFocus:true});
  const announcementUnreadQuery = trpc.platformAnnouncements.inbox.unreadCount.useQuery(undefined,{enabled:active,staleTime:0,refetchInterval:15000,refetchOnWindowFocus:true});
  const markAnnouncementRead = trpc.platformAnnouncements.inbox.markRead.useMutation({onSuccess:()=>{void announcementsQuery.refetch();void announcementUnreadQuery.refetch();},onError:error=>toast.error(error.message)});
  const latestChat=chatQuery.data??[];
  const latestAnnouncements=(announcementsQuery.data??[]).slice(0,50);
  const latestEvents=eventQuery.data??[];
  const unreadTotal=Number(chatUnreadQuery.data??latestChat.filter(x=>!x.read_at).length)+Number(unreadQuery.data??0)+Number(announcementUnreadQuery.data??0);
  const items=useMemo<CenterItem[]>(()=>[
    ...latestChat.map(item=>({kind:"chat" as const,id:item.id,createdAt:item.created_at,read:Boolean(item.read_at),title:item.title,body:item.body??"لديك رسالة جديدة في الدردشة.",targetPath:"/support-chat",row:item})),
    ...latestAnnouncements.map(item=>({kind:"announcement" as const,id:item.id,createdAt:item.publishedAt,read:Boolean(item.readAt),title:item.title,body:item.body,targetPath:"/announcements",row:item})),
    ...latestEvents.map(item=>({kind:"event" as const,id:item.id,createdAt:item.created_at,read:Boolean(item.read_at),title:item.title,body:item.body,targetPath:item.target_path,row:item})),
  ].sort((a,b)=>new Date(b.createdAt).getTime()-new Date(a.createdAt).getTime()).slice(0,12),[latestChat,latestAnnouncements,latestEvents]);
  const seenIds=useRef<Set<number>|null>(null);
  useEffect(()=>{if(!active)return;const channel=supabase.channel("powerhub-notifications-"+userId).on("postgres_changes",{event:"INSERT",schema:"public",table:"powerhub_user_notifications",filter:"user_id=eq."+userId},()=>{void queryClient.invalidateQueries({queryKey:[...UNREAD_QUERY_KEY,userId]});void queryClient.invalidateQueries({queryKey:[...EVENT_QUERY_KEY,userId]});}).subscribe();return()=>{void supabase.removeChannel(channel);};},[userId,queryClient,active]);
  useEffect(()=>{if(!active)return;const unsubscribe=subscribeToChatNotifications(userId,event=>{seenIds.current??=new Set<number>();if(seenIds.current.has(event.notification_id))return;seenIds.current.add(event.notification_id);void queryClient.invalidateQueries({queryKey:["notification-center","chat",userId]});void queryClient.invalidateQueries({queryKey:["notification-center","chat-unread",userId]});if(!mutedRef.current){try{const Ctx=window.AudioContext||(window as typeof window&{webkitAudioContext?:typeof AudioContext}).webkitAudioContext;if(Ctx){const ctx=new Ctx();const oscillator=ctx.createOscillator();const gain=ctx.createGain();oscillator.frequency.value=740;gain.gain.value=.035;oscillator.connect(gain);gain.connect(ctx.destination);oscillator.start();oscillator.stop(ctx.currentTime+.11);oscillator.onended=()=>void ctx.close();}}catch{/* Browser may block notification audio. */}}toast.info("وصل إشعار جديد في الدردشة والدعم.",{duration:3500});});return unsubscribe;},[userId,queryClient,active]);
  useEffect(()=>{if(!chatQuery.data)return;const ids=new Set(chatQuery.data.map(x=>x.id));if(seenIds.current===null){seenIds.current=ids;return;}seenIds.current=new Set([...seenIds.current,...ids]);},[chatQuery.data]);
  const loadAllSources=async()=>{
    await Promise.all([
      chatQuery.refetch(), chatUnreadQuery.refetch(), eventQuery.refetch(),
      unreadQuery.refetch(), announcementsQuery.refetch(), announcementUnreadQuery.refetch(),
    ]);
    // Only after fresh lists have arrived, mark the items actually visible in the bell.
    setMarkVisiblePending(true);
  };
  useEffect(()=>{
    if(!markVisiblePending)return;
    setMarkVisiblePending(false);
    const visibleUnread=items.filter(item=>!item.read);
    if(!visibleUnread.length)return;
    void (async()=>{
      const results=await Promise.allSettled(visibleUnread.map(async item=>{
        if(item.kind==="chat") {
          await markChatNotificationRead(Number(item.id));
        } else if(item.kind==="announcement") {
          await markAnnouncementRead.mutateAsync({id:Number(item.id)});
        } else {
          const {error}=await supabase.rpc("powerhub_notification_mark_read",{p_notification_id:Number(item.id)});
          if(error)throw error;
        }
      }));
      const failedCount=results.filter(result=>result.status==="rejected").length;
      await Promise.all([
        queryClient.invalidateQueries({queryKey:["notification-center","chat",userId]}),
        queryClient.invalidateQueries({queryKey:["notification-center","chat-unread",userId]}),
        queryClient.invalidateQueries({queryKey:[...EVENT_QUERY_KEY,userId]}),
        queryClient.invalidateQueries({queryKey:[...UNREAD_QUERY_KEY,userId]}),
        queryClient.invalidateQueries({queryKey:["platformAnnouncements"]}),
      ]);
      if(failedCount>0)toast.error("تعذر تعليم بعض الإشعارات الظاهرة كمقروءة. سيبقى عددها ظاهرًا حتى ينجح التحديث.");
    })();
  },[markVisiblePending,items,userId,queryClient,markAnnouncementRead]);
  const toggleSound=()=>{const next=!muted;setMuted(next);try{window.localStorage.setItem(SOUND_KEY,next?"1":"0");}catch{/* optional preference */}};
  const openItem=async(item:CenterItem)=>{if(item.kind==="chat"){const row=item.row as ChatInboxNotification;if(!row.read_at){try{await markChatNotificationRead(row.id);await queryClient.invalidateQueries({queryKey:["notification-center","chat",userId]});await queryClient.invalidateQueries({queryKey:["notification-center","chat-unread",userId]});}catch(error){toast.error(error instanceof Error?error.message:"تعذر تحديث حالة الإشعار.");}}setLocation(item.targetPath);return;}if(item.kind==="announcement"){const row=item.row as {id:number;readAt:string|null};if(!row.readAt)markAnnouncementRead.mutate({id:row.id});setLocation(item.targetPath);return;}const row=item.row as StoredNotification;if(!row.read_at){const {error}=await supabase.rpc("powerhub_notification_mark_read",{p_notification_id:Number(row.id)});if(error){toast.error("تعذر تحديث حالة الإشعار.");return;}await queryClient.invalidateQueries({queryKey:[...EVENT_QUERY_KEY,userId]});await queryClient.invalidateQueries({queryKey:[...UNREAD_QUERY_KEY,userId]});}setLocation(item.targetPath);};
  const loading=chatQuery.isLoading||announcementsQuery.isLoading||eventQuery.isLoading;
  const failed=chatQuery.isError||announcementsQuery.isError||eventQuery.isError;
  if (!enabled) return null;
  return <DropdownMenu onOpenChange={(open)=>{if(open){void loadAllSources();}else{setMarkVisiblePending(false);}}}><DropdownMenuTrigger asChild><button type="button" aria-label={`الإشعارات، ${unreadTotal} غير مقروء`} title="الإشعارات" className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-black/15 bg-black/5 text-[#111827] transition-colors hover:bg-black/10 hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111827]"><BellRing className="h-5 w-5"/>{unreadTotal>0?<span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-rose-500 px-1 text-[9px] font-extrabold leading-4 text-white">{unreadTotal>99?"99+":unreadTotal}</span>:null}</button></DropdownMenuTrigger>
  <DropdownMenuContent align="end" className="w-[min(24rem,calc(100vw-1rem))] border-white/10 bg-[#1b222c] text-white"><div className="flex items-center justify-between gap-2 border-b border-white/8 px-3 py-3"><div><p className="font-bold">مركز الإشعارات</p><p className="mt-1 text-xs text-slate-400">{unreadTotal} غير مقروء</p></div><button type="button" aria-label={muted?"تشغيل صوت الإشعارات":"كتم صوت الإشعارات"} title={muted?"تشغيل الصوت":"كتم الصوت"} onClick={toggleSound} className="grid h-8 w-8 place-items-center rounded-lg text-slate-300 hover:bg-white/10">{muted?<VolumeX className="h-4 w-4"/>:<Volume2 className="h-4 w-4"/>}</button></div>
  {loading?<div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin"/>جارٍ تحميل الإشعارات…</div>:null}
  {failed?<div className="px-4 py-5 text-sm text-rose-300">تعذر تحميل بعض الإشعارات. <button type="button" onClick={()=>{void chatQuery.refetch();void announcementsQuery.refetch();void eventQuery.refetch();}} className="underline">إعادة المحاولة</button></div>:null}
  {!loading&&!failed&&!items.length?<div className="px-4 py-8 text-center text-sm text-slate-400">لا توجد إشعارات حتى الآن.</div>:null}
  {items.map(item=><DropdownMenuItem key={`${item.kind}:${item.id}`} onSelect={event=>{event.preventDefault();void openItem(item);}} className={`cursor-pointer items-start gap-2 whitespace-normal px-3 py-3 focus:bg-white/5 ${item.read?"opacity-75":"bg-white/[.035]"}`}><span className="mt-0.5 rounded-md bg-white/5 p-1.5">{item.kind==="chat"?<MessageSquareText className="h-4 w-4 text-sky-300"/>:item.kind==="announcement"?<Megaphone className="h-4 w-4 text-[#F5B800]"/>:<ClipboardList className="h-4 w-4 text-emerald-300"/>}</span><span className="min-w-0 flex-1"><span className="block font-semibold">{item.title}</span><span className="mt-1 block line-clamp-2 text-xs leading-5 text-slate-400">{item.body}</span><span className="mt-1 block text-[10px] text-slate-500">{new Date(item.createdAt).toLocaleString("ar-PS",{dateStyle:"short",timeStyle:"short",timeZone:"Asia/Gaza"})}</span></span>{item.read?<Check className="mt-1 h-3.5 w-3.5 text-emerald-300"/>:null}</DropdownMenuItem>)}
  <DropdownMenuSeparator className="bg-white/10"/><DropdownMenuItem onSelect={()=>setLocation("/notifications-center")} className="cursor-pointer justify-between text-sm focus:bg-white/5">فتح مركز الإشعارات الكامل <ExternalLink className="h-3.5 w-3.5"/></DropdownMenuItem><DropdownMenuItem onSelect={()=>setLocation("/announcements")} className="cursor-pointer justify-between text-sm focus:bg-white/5">عرض جميع الإعلانات <ExternalLink className="h-3.5 w-3.5"/></DropdownMenuItem></DropdownMenuContent></DropdownMenu>;
}
