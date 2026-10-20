import { useEffect, useMemo, useRef, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BellRing, CheckCheck, ClipboardList, Loader2, Megaphone, MessageSquareText, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { listChatNotifications, markChatNotificationRead, type ChatInboxNotification } from "@/lib/chatReceipts";
import { supabase } from "@/lib/supabase";
import { useQuery, useQueryClient } from "@tanstack/react-query";

type StoredNotification = {id:number;user_id:number;tenant_id:number|null;notification_type:string;title:string;body:string;target_path:string;entity_type:string|null;entity_id:string|null;dedupe_key:string;metadata:Record<string,unknown>;read_at:string|null;created_at:string};
export default function NotificationsCenterPage(){
 const auth=trpc.auth.me.useQuery();
 const userId=Number(auth.data?.id??0);
 const client=useQueryClient();
 const [filter,setFilter]=useState<"all"|"unread">("all");
 const eventsLoadedRef=useRef(false);
 const chats=useQuery({queryKey:["notification-center","chat",userId],queryFn:()=>listChatNotifications(100),enabled:userId>0,refetchOnWindowFocus:true});
 const events=useQuery({queryKey:["notification-center","events",userId],queryFn:async()=>{const {data,error}=await supabase.rpc("powerhub_notification_list",{p_limit:100});if(error)throw error;return (data??[]) as StoredNotification[];},enabled:userId>0,staleTime:60000,refetchOnWindowFocus:false});
 const announcements=trpc.platformAnnouncements.inbox.list.useQuery(undefined,{enabled:userId>0,staleTime:60000,refetchOnWindowFocus:false});
 const utils=trpc.useUtils();
 useEffect(()=>{if(!userId)return;const channel=supabase.channel("powerhub-notifications-page-"+userId).on("postgres_changes",{event:"INSERT",schema:"public",table:"powerhub_user_notifications",filter:"user_id=eq."+userId},()=>{if(eventsLoadedRef.current)void client.invalidateQueries({queryKey:["notification-center","events",userId]});}).subscribe();return()=>{void supabase.removeChannel(channel);};},[userId,client]);
 const rows=useMemo(()=>[
  ...(chats.data??[]).map(x=>({key:"chat:"+x.id,kind:"chat" as const,id:x.id,title:x.title,body:x.body??"رسالة جديدة في الدردشة",createdAt:x.created_at,read:Boolean(x.read_at),path:"/support-chat",raw:x})),
  ...(events.data??[]).map(x=>({key:"event:"+x.id,kind:"event" as const,id:x.id,title:x.title,body:x.body,createdAt:x.created_at,read:Boolean(x.read_at),path:x.target_path,raw:x})),
  ...(announcements.data??[]).map(x=>({key:"announcement:"+x.id,kind:"announcement" as const,id:x.id,title:x.title,body:x.body,createdAt:x.publishedAt??"",read:Boolean(x.readAt),path:"/announcements",raw:x})),
 ].sort((a,b)=>new Date(b.createdAt).getTime()-new Date(a.createdAt).getTime()),[chats.data,events.data,announcements.data]);
 const visible=filter==="unread"?rows.filter(x=>!x.read):rows;
 const unread=rows.filter(x=>!x.read).length;
 const loading=chats.isLoading||events.isLoading||announcements.isLoading;
 const refresh=()=>{eventsLoadedRef.current=true;void chats.refetch();void events.refetch();void announcements.refetch();};
 const markAll=async()=>{try{
  const unreadChats=(chats.data??[]).filter(x=>!x.read_at);
  const unreadAnnouncements=(announcements.data??[]).filter(x=>!x.readAt);
  const failures:string[]=[];
  const chatResults=await Promise.allSettled(unreadChats.map(x=>markChatNotificationRead(x.id)));
  if(chatResults.some(x=>x.status==="rejected"))failures.push("الدردشة");
  const eventResult=await supabase.rpc("powerhub_notification_mark_all_read");
  if(eventResult.error)failures.push("إشعارات الأحداث");
  if(unreadAnnouncements.length){
   try{await utils.client.platformAnnouncements.inbox.markManyRead.mutate({ids:unreadAnnouncements.map(x=>x.id)});}
   catch{failures.push("الإعلانات");}
  }
  refresh();
  if(failures.length)toast.error("تعذر تعليم جميع الإشعارات كمقروءة في: "+failures.join("، "));
  else toast.success("تم تعليم جميع الإشعارات كمقروءة.");
 }catch{toast.error("تعذر تحديث حالة الإشعارات.");}};
 const open=async(row:typeof rows[number])=>{try{
  if(row.kind==="chat"){const x=row.raw as ChatInboxNotification;if(!x.read_at)await markChatNotificationRead(x.id);}
  else if(row.kind==="event"){const x=row.raw as StoredNotification;if(!x.read_at){const {error}=await supabase.rpc("powerhub_notification_mark_read",{p_notification_id:x.id});if(error)throw error;}}
  else {const x=row.raw as {id:number;readAt:string|null};if(!x.readAt)await utils.client.platformAnnouncements.inbox.markRead.mutate({id:x.id});}
  refresh();window.location.assign(row.path);
 }catch{toast.error("تعذر فتح الإشعار أو تحديث حالة قراءته.");}};
 return <DashboardLayout><main dir="rtl" className="mx-auto max-w-5xl space-y-5 pb-12">
  <header className="rounded-2xl border border-[#F5B800]/20 bg-[#111823] p-5 sm:p-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><BellRing className="h-4 w-4"/>التواصل والتنبيهات</div><h1 className="mt-2 text-2xl font-extrabold text-white">مركز الإشعارات</h1><p className="mt-2 text-sm leading-7 text-slate-400">الدردشة، إعلانات المنصة، وطلبات التشغيل والإدارة في مكان واحد.</p></div><div className="flex gap-2"><Button variant="outline" onClick={refresh} className="border-white/15 bg-transparent text-white hover:bg-white/5"><RefreshCw className="ml-2 h-4 w-4"/>تحديث</Button><Button disabled={!unread||loading} onClick={()=>void markAll()} className="bg-[#F5B800] font-bold text-[#111823] hover:bg-[#ffd23f]"><CheckCheck className="ml-2 h-4 w-4"/>تعليم الكل كمقروء</Button></div></div><div className="mt-5 flex flex-wrap items-center gap-2"><Badge className="bg-rose-400/10 text-rose-300">{unread} غير مقروء</Badge><Button size="sm" variant={filter==="all"?"default":"outline"} onClick={()=>setFilter("all")} className={filter==="all"?"bg-white text-slate-900 hover:bg-slate-200":"border-white/15 bg-transparent text-slate-300"}>الكل ({rows.length})</Button><Button size="sm" variant={filter==="unread"?"default":"outline"} onClick={()=>setFilter("unread")} className={filter==="unread"?"bg-white text-slate-900 hover:bg-slate-200":"border-white/15 bg-transparent text-slate-300"}>غير المقروء ({unread})</Button></div></header>
  {loading?<div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400"><Loader2 className="h-5 w-5 animate-spin"/>جارٍ تحميل الإشعارات…</div>:null}
  {!loading&&(chats.isError||events.isError||announcements.isError)?<Card className="border-rose-400/20 bg-[#111823]"><CardContent className="p-5 text-sm text-rose-300">تعذر تحميل بعض مصادر الإشعارات. <button className="underline" onClick={refresh}>إعادة المحاولة</button></CardContent></Card>:null}
  {!loading&&!visible.length?<Card className="border-white/10 bg-[#111823]"><CardContent className="p-12 text-center"><BellRing className="mx-auto h-8 w-8 text-slate-600"/><p className="mt-4 font-bold text-white">{filter==="unread"?"لا توجد إشعارات غير مقروءة.":"لا توجد إشعارات حتى الآن."}</p><p className="mt-2 text-sm text-slate-500">سيظهر هنا أي إشعار جديد مرتبط بحسابك وصلاحياتك.</p></CardContent></Card>:null}
  <section className="space-y-3">{visible.map(row=><button key={row.key} onClick={()=>void open(row)} className={`w-full rounded-2xl border p-4 text-right transition hover:border-[#F5B800]/30 sm:p-5 ${row.read?"border-white/8 bg-[#111823]":"border-[#F5B800]/25 bg-[#111823]"}`}><span className="flex items-start gap-3"><span className="mt-1 rounded-xl bg-white/5 p-2">{row.kind==="chat"?<MessageSquareText className="h-5 w-5 text-sky-300"/>:row.kind==="announcement"?<Megaphone className="h-5 w-5 text-[#F5B800]"/>:<ClipboardList className="h-5 w-5 text-emerald-300"/>}</span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><span className="font-bold text-white">{row.title}</span><Badge className={row.read?"bg-white/5 text-slate-400":"bg-rose-400/10 text-rose-300"}>{row.read?"مقروء":"جديد"}</Badge></span><span className="mt-2 block whitespace-pre-wrap text-sm leading-7 text-slate-300">{row.body}</span><span className="mt-2 block text-xs text-slate-500">{new Date(row.createdAt).toLocaleString("ar-PS",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Gaza"})}</span></span></span></button>)}</section>
 </main></DashboardLayout>;
}
