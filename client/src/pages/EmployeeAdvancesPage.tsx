import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { can } from "@shared/powerhub-rbac";
import { HandCoins, Plus, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const money=(value: unknown)=>new Intl.NumberFormat("ar-PS",{maximumFractionDigits:2}).format(Number(value??0));
const today=()=>new Date().toISOString().slice(0,10);
const newKey=()=>globalThis.crypto.randomUUID();
export default function EmployeeAdvancesPage({embedded=false}:{embedded?:boolean}){
  const utils=trpc.useUtils();
  const sites=trpc.powerhub.sites.list.useQuery(undefined);
  const {branchId:siteId}=useBranchFilter(sites.data);
  const access=trpc.powerhub.staff.myAccess.useQuery({siteId:siteId??0},{enabled:Boolean(siteId)});
  const allowed=(access.data?.role==="owner"||access.data?.role==="accountant")&&can(access.data.role,"manageExpenses",access.data.permissions);
  const employees=trpc.powerhub.hr.listEmployees.useQuery({siteId:siteId??0,employmentStatus:"active"},{enabled:Boolean(siteId)});
  const accounts=trpc.powerhub.companyAccounts.list.useQuery({siteId:siteId??0},{enabled:Boolean(siteId)});
  const advances=trpc.powerhub.hr.listEmployeeAdvances.useQuery({siteId:siteId??0},{enabled:Boolean(siteId)});
  const [showIssue,setShowIssue]=useState(false);
  const [employeeId,setEmployeeId]=useState("");
  const [kind,setKind]=useState<"salary_advance"|"employee_loan">("salary_advance");
  const [amount,setAmount]=useState("");
  const [monthly,setMonthly]=useState("");
  const [accountId,setAccountId]=useState("");
  const [date,setDate]=useState(today());
  const [reason,setReason]=useState("");
  const [repayId,setRepayId]=useState<number|null>(null);
  const [repayAmount,setRepayAmount]=useState("");
  const [repayAccount,setRepayAccount]=useState("");
  const [repayDate,setRepayDate]=useState(today());
  const [repayNotes,setRepayNotes]=useState("");
  const refresh=async()=>{await Promise.all([advances.refetch(),accounts.refetch()]);};
  const issue=trpc.powerhub.hr.issueEmployeeAdvance.useMutation({onSuccess:async()=>{await refresh();setShowIssue(false);setAmount("");setMonthly("");setReason("");toast.success("تم صرف السلفة/الدين وتسجيل حركة الحساب.");},onError:e=>toast.error(e.message)});
  const repay=trpc.powerhub.hr.repayEmployeeAdvance.useMutation({onSuccess:async()=>{await refresh();setRepayId(null);setRepayAmount("");setRepayNotes("");toast.success("تم تسجيل السداد وتحديث الرصيد المتبقي.");},onError:e=>toast.error(e.message)});
  const content=<div dir="rtl" className="space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-[#111823] p-5"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><HandCoins className="h-4 w-4"/>السلف والديون</div><h1 className="mt-2 text-2xl font-extrabold text-white">سجل سلف الموظفين وديونهم</h1><p className="mt-1 text-sm text-slate-400">كل صرف مرتبط بحساب الشركة، مع سداد جزئي ورصيد متبقٍ وسجل تدقيقي.</p></div>{allowed?<Button onClick={()=>setShowIssue(v=>!v)} className="bg-[#F5B800] font-bold text-[#0D1117]"><Plus className="ml-2 h-4 w-4"/>تسجيل سلفة أو دين</Button>:null}</header>
    {showIssue&&allowed?<Card className="border-white/10 bg-[#111823]"><CardContent className="p-4"><form className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" onSubmit={e=>{e.preventDefault();if(!siteId||!employeeId||!accountId)return toast.error("اختر الموظف وحساب الصرف.");const n=Number(amount),m=Number(monthly);if(!(n>0)||!Number.isFinite(n))return toast.error("أدخل مبلغًا صحيحًا.");if(kind==="employee_loan"&&(!(m>0)||m>n))return toast.error("القسط الشهري يجب أن يكون موجبًا وألا يتجاوز مبلغ الدين.");issue.mutate({siteId,employeeId:Number(employeeId),advanceKind:kind,amount:n,...(kind==="employee_loan"?{monthlyDeduction:m}:{}),accountId:Number(accountId),paymentDate:date,reason,operationKey:newKey()});}}>
      <label className="text-sm text-slate-300">الموظف<select required value={employeeId} onChange={e=>setEmployeeId(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"><option value="">اختر الموظف</option>{employees.data?.map(p=><option key={p.id} value={p.id}>{p.fullName}</option>)}</select></label>
      <label className="text-sm text-slate-300">النوع<select value={kind} onChange={e=>setKind(e.target.value as typeof kind)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"><option value="salary_advance">سلفة من الراتب</option><option value="employee_loan">دين / قرض على الموظف</option></select></label>
      <label className="text-sm text-slate-300">المبلغ (شيكل)<input required type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"/></label>
      {kind==="employee_loan"?<label className="text-sm text-slate-300">القسط الشهري (شيكل)<input required type="number" min="0.01" step="0.01" value={monthly} onChange={e=>setMonthly(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"/></label>:null}
      <label className="text-sm text-slate-300">حساب الصرف<select required value={accountId} onChange={e=>setAccountId(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"><option value="">اختر حساب الشركة</option>{accounts.data?.filter(a=>a.isActive).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label className="text-sm text-slate-300">تاريخ الصرف<input required type="date" value={date} onChange={e=>setDate(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"/></label>
      <label className="text-sm text-slate-300 sm:col-span-2">السبب / البيان<input required minLength={3} maxLength={255} value={reason} onChange={e=>setReason(e.target.value)} placeholder="مثال: سلفة قبل موعد الراتب أو قرض طارئ" className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"/></label>
      <div className="flex items-end gap-2 sm:col-span-2 xl:col-span-4"><Button type="submit" disabled={issue.isPending||!siteId} className="bg-[#F5B800] text-[#0D1117]">{issue.isPending?"جارٍ الحفظ…":"تأكيد الصرف"}</Button><Button type="button" variant="outline" onClick={()=>setShowIssue(false)} className="border-white/10 text-white">إلغاء</Button></div>
    </form></CardContent></Card>:null}
    <Card className="border-white/10 bg-[#111823]"><CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-right text-sm"><thead className="text-xs text-slate-400"><tr>{["الموظف","النوع","المبلغ الأصلي","الرصيد المتبقي","القسط","الحالة","التاريخ","سجل السداد","الإجراء"].map(h=><th key={h} className="px-4 py-3">{h}</th>)}</tr></thead><tbody>{advances.data?.map(({adjustment:a,employee:p,repayments})=><tr key={a.id} className="border-t border-white/10"><td className="px-4 py-3 font-semibold text-white">{p.fullName}</td><td className="px-4 py-3 text-slate-300">{a.advanceKind==="employee_loan"?"دين / قرض":"سلفة راتب"}</td><td className="px-4 py-3 text-slate-300">{money(a.amount)} ش</td><td className="px-4 py-3 font-bold text-[#F5B800]">{money(a.remainingAmount)} ش</td><td className="px-4 py-3 text-slate-300">{a.monthlyDeduction?money(a.monthlyDeduction)+" ش":"من أقرب راتب"}</td><td className="px-4 py-3">{a.status==="open"?"مفتوح":a.status==="settled"?"مسدد":"ملغى"}</td><td className="px-4 py-3 text-slate-400">{a.disbursedAt?new Date(a.disbursedAt).toLocaleDateString("ar-PS"):new Date(a.createdAt).toLocaleDateString("ar-PS")}</td><td className="px-4 py-3"><div className="max-w-[280px] space-y-1">{repayments.length?repayments.map(r=><div key={r.id} className="rounded-md border border-white/10 p-2 text-xs text-slate-300"><div className="font-semibold text-white">{money(r.amount)} ش</div><div>{r.repaymentMethod==="payroll"?"استرداد من الراتب — كشف #"+r.payrollRunId:"سداد "+(r.repaymentMethod==="cash"?"نقدي":r.repaymentMethod==="bank"?"بنكي":"محفظة")+" — "+(accounts.data?.find(a=>a.id===r.companyAccountId)?.name??"حساب الشركة")}</div><div className="text-slate-400">{new Date(r.paymentDate+"T00:00:00").toLocaleDateString("ar-PS")}</div>{r.referenceNo?<div>المرجع: {r.referenceNo}</div>:null}{r.notes?<div>{r.notes}</div>:null}</div>):<span className="text-slate-500">لا توجد عمليات سداد مسجلة</span>}</div></td><td className="px-4 py-3">{allowed&&a.status==="open"?<Button size="sm" variant="outline" className="border-white/10 text-white" onClick={()=>{setRepayId(a.id);setRepayAmount(String(a.remainingAmount));setRepayAccount("");setRepayNotes("");}}>تسجيل سداد</Button>:null}</td></tr>)}</tbody></table>{!advances.isLoading&&!advances.data?.length?<div className="p-10 text-center text-sm text-slate-400">لا توجد سلف أو ديون مسجلة لهذا الفرع.</div>:null}</div></CardContent></Card>
    {repayId!==null&&allowed?<Card className="border-white/10 bg-[#111823]"><CardContent className="p-4"><h2 className="mb-3 font-bold text-white"><RotateCcw className="ml-2 inline h-4 w-4 text-[#F5B800]"/>تسجيل سداد جزئي أو كامل</h2><form className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" onSubmit={e=>{e.preventDefault();if(!siteId||!repayAccount)return toast.error("اختر الحساب الذي استلم السداد.");const a=(advances.data??[]).find(x=>x.adjustment.id===repayId)?.adjustment;if(!a)return toast.error("تعذر العثور على السلفة.");const n=Number(repayAmount);if(!(n>0)||n>Number(a.remainingAmount))return toast.error("المبلغ أكبر من الرصيد المتبقي أو غير صحيح.");repay.mutate({siteId,adjustmentId:repayId,accountId:Number(repayAccount),amount:n,paymentDate:repayDate,notes:repayNotes||undefined,operationKey:newKey()});}}>
      <label className="text-sm text-slate-300">مبلغ السداد<input required type="number" min="0.01" step="0.01" value={repayAmount} onChange={e=>setRepayAmount(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"/></label>
      <label className="text-sm text-slate-300">الحساب المستلم<select required value={repayAccount} onChange={e=>setRepayAccount(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"><option value="">اختر حساب الشركة</option>{accounts.data?.filter(a=>a.isActive).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label className="text-sm text-slate-300">تاريخ السداد<input required type="date" value={repayDate} onChange={e=>setRepayDate(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"/></label>
      <label className="text-sm text-slate-300">ملاحظات<input maxLength={500} value={repayNotes} onChange={e=>setRepayNotes(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"/></label>
      <div className="flex gap-2 sm:col-span-2 xl:col-span-4"><Button type="submit" disabled={repay.isPending} className="bg-[#F5B800] text-[#0D1117]">{repay.isPending?"جارٍ التسجيل…":"تأكيد السداد"}</Button><Button type="button" variant="outline" onClick={()=>setRepayId(null)} className="border-white/10 text-white">إلغاء</Button></div>
    </form></CardContent></Card>:null}
  </div>;
  return embedded?content:<DashboardLayout>{content}</DashboardLayout>;
}
