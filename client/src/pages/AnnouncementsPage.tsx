import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { BellRing, CalendarDays, CheckCircle2, Loader2, Megaphone } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const typeLabels: Record<string,string>={news:"خبر",announcement:"إعلان",maintenance:"صيانة",alert:"تنبيه"};
const typeClass: Record<string,string>={news:"bg-sky-400/10 text-sky-300",announcement:"bg-[#F5B800]/10 text-[#F5B800]",maintenance:"bg-violet-400/10 text-violet-300",alert:"bg-rose-400/10 text-rose-300"};
const dateTime=(v?:string|null)=>v?new Date(v).toLocaleString("ar-PS",{dateStyle:"medium",timeStyle:"short",hour12:true,timeZone:"Asia/Gaza"}):"—";

export default function AnnouncementsPage(){
 const q=trpc.platformAnnouncements.inbox.list.useQuery();
 const utils=trpc.useUtils();
 const read=trpc.platformAnnouncements.inbox.markRead.useMutation({onSuccess:async()=>{await utils.platformAnnouncements.inbox.list.invalidate();},onError:e=>toast.error(e.message)});
 const [selected,setSelected]=useState<number|null>(null);
 const unread=useMemo(()=> (q.data??[]).filter(x=>!x.readAt).length,[q.data]);
 const open=(id:number)=>{setSelected(id);const row=(q.data??[]).find(x=>x.id===id);if(row&&!row.readAt)read.mutate({id});};
 return <DashboardLayout><main className="mx-auto max-w-5xl space-y-6 pb-12" dir="rtl">
  <header className="rounded-[26px] border border-[#F5B800]/20 bg-[#111823] p-6 shadow-panel">
   <div className="flex items-center justify-between gap-4"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><BellRing className="h-4 w-4"/>التواصل الداخلي</div><h1 className="mt-2 text-2xl font-extrabold text-white">أخبار وإعلانات PowerHub</h1><p className="mt-2 text-sm leading-7 text-slate-400">آخر الأخبار والتنبيهات التي تنشرها إدارة المنصة.</p></div><Badge className={unread?"bg-rose-400/10 text-rose-300":"bg-emerald-400/10 text-emerald-300"}>{unread?unread+" غير مقروء":"كل الأخبار مقروءة"}</Badge></div>
  </header>
  {q.isLoading?<div className="flex items-center gap-2 py-10 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin text-[#F5B800]"/>جارٍ تحميل الأخبار…</div>:!(q.data??[]).length?<Card className="border-white/8 bg-[#111823]"><CardContent className="p-10 text-center"><Megaphone className="mx-auto h-8 w-8 text-slate-600"/><p className="mt-4 font-bold text-slate-300">لا توجد أخبار أو إعلانات منشورة حاليًا.</p></CardContent></Card>:<div className="space-y-4">{(q.data??[]).map(row=><Card key={row.id} className={row.readAt?"border-white/8 bg-[#111823]":"border-[#F5B800]/25 bg-[#111823] shadow-[0_8px_30px_rgba(245,184,0,.06)]"}><CardContent className="p-5"><button type="button" onClick={()=>open(row.id)} className="w-full text-right outline-none"><div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-extrabold text-white">{row.title}</h2><Badge className={typeClass[row.type]??"bg-white/5 text-slate-300"}>{typeLabels[row.type]??row.type}</Badge>{!row.readAt?<Badge className="bg-rose-400/10 text-rose-300">جديد</Badge>:<Badge className="bg-emerald-400/10 text-emerald-300"><CheckCircle2 className="ml-1 h-3 w-3"/>مقروء</Badge>}</div><div className="mt-3 flex items-center gap-1 text-xs text-slate-500"><CalendarDays className="h-3.5 w-3.5"/>{dateTime(row.publishedAt)}</div><p className="mt-4 whitespace-pre-wrap text-sm leading-8 text-slate-300">{row.body}</p></button>{selected===row.id&&row.readAt?<div className="mt-4 text-xs text-emerald-300">تم تسجيل قراءة الإعلان.</div>:null}</CardContent></Card>)}</div>}
 </main></DashboardLayout>;
}