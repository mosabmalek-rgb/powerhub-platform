import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { usePowerHubConnectivity } from "@/lib/offline-connectivity";
import { enqueueOfflineHrWork, listOfflineWork, type HrEmployeeCreateDraft } from "@/lib/offline-work-queue";
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
  const auth=useAuth();
  const {isOnline}=usePowerHubConnectivity();
  const userId=Number(auth.user?.id);
  const tenantId=Number((sites.data as any[]|undefined)?.find((site)=>site.id===siteId)?.tenantId);
  const isHrOnline=isOnline&&auth.isOnlineAuthenticated&&auth.powerHubReachable;
  const access=trpc.powerhub.staff.myAccess.useQuery({siteId:siteId??0},{enabled:Boolean(siteId)&&isHrOnline});
  const serverAllowed=(access.data?.role==="owner"||access.data?.role==="accountant")&&can(access.data.role,"manageExpenses",access.data.permissions);
  // Offline queueing is an untrusted draft: the server rechecks the user's exact role, account status and balances before it can mutate anything.
  const allowed=isHrOnline?serverAllowed:Boolean(siteId&&Number.isSafeInteger(userId)&&userId>0);
  const employees=trpc.powerhub.hr.listEmployees.useQuery({siteId:siteId??0,employmentStatus:"active"},{enabled:Boolean(siteId)&&isHrOnline});
  const offlineDirectory=trpc.powerhub.hr.offlineDirectory.useQuery({siteId:siteId??0},{enabled:Boolean(siteId)});
  const displayEmployees:any[]=isHrOnline&&employees.data?employees.data:(offlineDirectory.data??[]).filter((employee)=>employee.employmentStatus==="active");
  const accounts=trpc.powerhub.companyAccounts.list.useQuery({siteId:siteId??0},{enabled:Boolean(siteId)});
  const advances=trpc.powerhub.hr.listEmployeeAdvances.useQuery({siteId:siteId??0},{enabled:Boolean(siteId)&&isHrOnline});
  const offlineAdvances=trpc.powerhub.hr.offlineEmployeeAdvances.useQuery({siteId:siteId??0},{enabled:Boolean(siteId)});
  const displayAdvances:any[]=isHrOnline&&advances.data?advances.data:offlineAdvances.data??[];
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
  const submitIssue=async(e:React.FormEvent<HTMLFormElement>)=>{
    e.preventDefault();
    if(!siteId||!employeeId||!accountId)return toast.error("اختر الموظف وحساب الصرف.");
    const n=Number(amount),m=Number(monthly),selectedEmployeeId=Number(employeeId),selectedAccountId=Number(accountId);
    if(!(n>0)||!Number.isFinite(n))return toast.error("أدخل مبلغًا صحيحًا.");
    if(kind==="employee_loan"&&(!(m>0)||m>n))return toast.error("القسط الشهري يجب أن يكون موجبًا وألا يتجاوز مبلغ الدين.");
    const selectedAccount=(accounts.data??[]).find((account)=>Number(account.id)===selectedAccountId);
    if(!selectedAccount||!selectedAccount.isActive)return toast.error("لا يوجد حساب صرف نشط في النسخة المحلية؛ حدّث الحسابات عند الاتصال أولاً.");
    if(isHrOnline){
      issue.mutate({siteId,employeeId:selectedEmployeeId,advanceKind:kind,amount:n,...(kind==="employee_loan"?{monthlyDeduction:m}:{}),accountId:selectedAccountId,paymentDate:date,reason,operationKey:newKey()});
      return;
    }
    if(!Number.isSafeInteger(userId)||userId<1||!Number.isSafeInteger(tenantId)||tenantId<1)return toast.error("لا تتوفر هوية المستخدم ونطاق الشركة المحفوظان؛ لم يُحفظ الطلب.");
    try{
      const queuedItems=await listOfflineWork({userId,siteId});
      const pendingCreate=selectedEmployeeId<0?queuedItems.find((item)=>item.kind==="employee_create"&&item.status!=="applied"&&(item.payload as HrEmployeeCreateDraft).localEmployeeId===selectedEmployeeId):undefined;
      const localAdjustmentId=-Date.now();
      const payload={employeeId:selectedEmployeeId,advanceKind:kind,amount:n,...(kind==="employee_loan"?{monthlyDeduction:m}:{}),accountId:selectedAccountId,paymentDate:date,reason,localAdjustmentId};
      await enqueueOfflineHrWork({userId,tenantId,siteId,kind:"employee_advance_issue",dependsOn:pendingCreate?[pendingCreate.clientOperationId]:[],payload});
      const person=displayEmployees.find((employee)=>Number(employee.id)===selectedEmployeeId);
      const optimistic={adjustment:{id:localAdjustmentId,tenantId,employeeId:selectedEmployeeId,siteId,adjustmentType:"advance",advanceKind:kind,monthlyDeduction:kind==="employee_loan"?String(m):null,amount:String(n),remainingAmount:String(n),reason:null,status:"open",createdByUserId:null,createdAt:new Date(),updatedAt:new Date(),pendingOffline:true},employee:{id:selectedEmployeeId,tenantId,siteId,fullName:person?.fullName??"موظف محلي",jobTitle:person?.jobTitle??"other",employmentStatus:person?.employmentStatus??"active"},repayments:[]};
      utils.powerhub.hr.offlineEmployeeAdvances.setData({siteId},(current:any)=>[optimistic,...(current??[]).filter((row:any)=>row.adjustment.id!==localAdjustmentId)].slice(0,500));
      setShowIssue(false);setAmount("");setMonthly("");setReason("");
      toast.success("حُفظ طلب السلفة محليًا. لم يُصرف المال ولم يتغير رصيد الحساب حتى يؤكده الخادم.");
    }catch(error){toast.error(error instanceof Error?error.message:"تعذر حفظ طلب السلفة محليًا.");}
  };
  const submitRepayment=async(e:React.FormEvent<HTMLFormElement>)=>{
    e.preventDefault();
    if(!siteId||!repayId||!repayAccount)return toast.error("اختر حساب استلام السداد.");
    const row=displayAdvances.find((item)=>Number(item.adjustment.id)===Number(repayId));
    const a=row?.adjustment;
    if(!a||a.status!=="open")return toast.error("السلفة غير متاحة للسداد.");
    const n=Number(repayAmount),selectedAccountId=Number(repayAccount);
    if(!(n>0)||!Number.isFinite(n)||n>Number(a.remainingAmount))return toast.error("المبلغ أكبر من الرصيد المحلي المتبقي أو غير صحيح؛ سيتحقق الخادم من الرصيد النهائي.");
    const selectedAccount=(accounts.data??[]).find((account)=>Number(account.id)===selectedAccountId);
    if(!selectedAccount||!selectedAccount.isActive)return toast.error("لا يوجد حساب استلام نشط في النسخة المحلية.");
    if(isHrOnline){
      repay.mutate({siteId,adjustmentId:repayId,accountId:selectedAccountId,amount:n,paymentDate:repayDate,notes:repayNotes||undefined,operationKey:newKey()});
      return;
    }
    if(!Number.isSafeInteger(userId)||userId<1||!Number.isSafeInteger(tenantId)||tenantId<1)return toast.error("لا تتوفر هوية المستخدم ونطاق الشركة المحفوظان؛ لم يُحفظ طلب السداد.");
    try{
      const queue=await listOfflineWork({userId,siteId});
      const pendingIssue=repayId<0?queue.find((item)=>item.kind==="employee_advance_issue"&&item.status!=="applied"&&(item.payload as any).localAdjustmentId===repayId):undefined;
      const localRepaymentId=-Date.now();
      await enqueueOfflineHrWork({userId,tenantId,siteId,kind:"employee_advance_repayment",dependsOn:pendingIssue?[pendingIssue.clientOperationId]:[],payload:{adjustmentId:repayId,accountId:selectedAccountId,amount:n,paymentDate:repayDate,notes:repayNotes||undefined,localRepaymentId}});
      utils.powerhub.hr.offlineEmployeeAdvances.setData({siteId},(current:any)=> (current??[]).map((item:any)=>item.adjustment.id!==repayId?item:{
        ...item,
        adjustment:{...item.adjustment,remainingAmount:String(Math.max(0,Number(item.adjustment.remainingAmount)-n)),pendingOffline:true},
        repayments:[...(item.repayments??[]),{id:localRepaymentId,amount:String(n),repaymentMethod:"pending_offline",companyAccountId:selectedAccountId,paymentDate:repayDate,referenceNo:null,notes:null,createdByUserId:null,createdAt:new Date(),pendingOffline:true}],
      }));
      setRepayId(null);setRepayAmount("");setRepayNotes("");
      toast.success("حُفظ طلب السداد محليًا. لم يُسجّل قبض أو تُحدّث حسابات الشركة حتى نجاح المزامنة.");
    }catch(error){toast.error(error instanceof Error?error.message:"تعذر حفظ طلب السداد محليًا.");}
  };
  const content=<div dir="rtl" className="space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-[#111823] p-5"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><HandCoins className="h-4 w-4"/>السلف والديون</div><h1 className="mt-2 text-2xl font-extrabold text-white">سجل سلف الموظفين وديونهم</h1><p className="mt-1 text-sm text-slate-400">كل صرف مرتبط بحساب الشركة، مع سداد جزئي ورصيد متبقٍ وسجل تدقيقي.</p></div>{allowed?<Button onClick={()=>setShowIssue(v=>!v)} className="bg-[#F5B800] font-bold text-[#0D1117]"><Plus className="ml-2 h-4 w-4"/>تسجيل سلفة أو دين</Button>:null}</header>
    {showIssue&&allowed?<Card className="border-white/10 bg-[#111823]"><CardContent className="p-4"><form className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" onSubmit={submitIssue}>
      <label className="text-sm text-slate-300">الموظف<select required value={employeeId} onChange={e=>setEmployeeId(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"><option value="">اختر الموظف</option>{displayEmployees.map((p)=><option key={p.id} value={p.id}>{p.fullName}{p.id<0?" — لم تُزامن بعد":""}</option>)}</select></label>
      <label className="text-sm text-slate-300">النوع<select value={kind} onChange={e=>setKind(e.target.value as typeof kind)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"><option value="salary_advance">سلفة من الراتب</option><option value="employee_loan">دين / قرض على الموظف</option></select></label>
      <label className="text-sm text-slate-300">المبلغ (شيكل)<input required type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"/></label>
      {kind==="employee_loan"?<label className="text-sm text-slate-300">القسط الشهري (شيكل)<input required type="number" min="0.01" step="0.01" value={monthly} onChange={e=>setMonthly(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"/></label>:null}
      <label className="text-sm text-slate-300">حساب الصرف<select required value={accountId} onChange={e=>setAccountId(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"><option value="">اختر حساب الشركة</option>{accounts.data?.filter(a=>a.isActive).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label className="text-sm text-slate-300">تاريخ الصرف<input required type="date" value={date} onChange={e=>setDate(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"/></label>
      <label className="text-sm text-slate-300 sm:col-span-2">السبب / البيان<input required minLength={3} maxLength={255} value={reason} onChange={e=>setReason(e.target.value)} placeholder="مثال: سلفة قبل موعد الراتب أو قرض طارئ" className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"/></label>
      <div className="flex items-end gap-2 sm:col-span-2 xl:col-span-4"><Button type="submit" disabled={issue.isPending||!siteId} className="bg-[#F5B800] text-[#0D1117]">{issue.isPending?"جارٍ الحفظ…":"تأكيد الصرف"}</Button><Button type="button" variant="outline" onClick={()=>setShowIssue(false)} className="border-white/10 text-white">إلغاء</Button></div>
    </form></CardContent></Card>:null}
    <Card className="border-white/10 bg-[#111823]"><CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-right text-sm"><thead className="text-xs text-slate-400"><tr>{["الموظف","النوع","المبلغ الأصلي","الرصيد المتبقي","القسط","الحالة","التاريخ","سجل السداد","الإجراء"].map(h=><th key={h} className="px-4 py-3">{h}</th>)}</tr></thead><tbody>{displayAdvances.map(({adjustment:a,employee:p,repayments})=><tr key={a.id} className="border-t border-white/10"><td className="px-4 py-3 font-semibold text-white">{p.fullName}</td><td className="px-4 py-3 text-slate-300">{a.advanceKind==="employee_loan"?"دين / قرض":"سلفة راتب"}</td><td className="px-4 py-3 text-slate-300">{money(a.amount)} ش</td><td className="px-4 py-3 font-bold text-[#F5B800]">{money(a.remainingAmount)} ش</td><td className="px-4 py-3 text-slate-300">{a.monthlyDeduction?money(a.monthlyDeduction)+" ش":"من أقرب راتب"}</td><td className="px-4 py-3">{a.pendingOffline?"بانتظار المزامنة":a.status==="open"?"مفتوح":a.status==="settled"?"مسدد":"ملغى"}</td><td className="px-4 py-3 text-slate-400">{a.disbursedAt?new Date(a.disbursedAt).toLocaleDateString("ar-PS"):new Date(a.createdAt).toLocaleDateString("ar-PS")}</td><td className="px-4 py-3"><div className="max-w-[280px] space-y-1">{repayments.length?repayments.map((r:any)=><div key={r.id} className="rounded-md border border-white/10 p-2 text-xs text-slate-300"><div className="font-semibold text-white">{money(r.amount)} ش</div><div>{r.pendingOffline||r.repaymentMethod==="pending_offline"?"طلب سداد بانتظار المزامنة":r.repaymentMethod==="payroll"?"استرداد من الراتب — كشف #"+r.payrollRunId:"سداد "+(r.repaymentMethod==="cash"?"نقدي":r.repaymentMethod==="bank"?"بنكي":"محفظة")+" — "+(accounts.data?.find(a=>a.id===r.companyAccountId)?.name??"حساب الشركة")}</div><div className="text-slate-400">{new Date(r.paymentDate+"T00:00:00").toLocaleDateString("ar-PS")}</div>{r.referenceNo?<div>المرجع: {r.referenceNo}</div>:null}{r.notes?<div>{r.notes}</div>:null}</div>):<span className="text-slate-500">لا توجد عمليات سداد مسجلة</span>}</div></td><td className="px-4 py-3">{allowed&&a.status==="open"?<Button size="sm" variant="outline" className="border-white/10 text-white" onClick={()=>{setRepayId(a.id);setRepayAmount(String(a.remainingAmount));setRepayAccount("");setRepayNotes("");}}>تسجيل سداد</Button>:null}</td></tr>)}</tbody></table>{!advances.isLoading&&!displayAdvances.length?<div className="p-10 text-center text-sm text-slate-400">لا توجد سلف أو ديون مسجلة لهذا الفرع.</div>:null}</div></CardContent></Card>
    {!isHrOnline?<p role="status" className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-sm leading-6 text-amber-100">عمليات السلف والسداد دون اتصال هي طلبات معلّقة فقط؛ لا يتغير رصيد حساب الشركة ولا يُعتمد الصرف أو القبض حتى يتحقق الخادم من الصلاحية والرصيد والفترة المالية.</p>:null}{repayId!==null&&allowed?<Card className="border-white/10 bg-[#111823]"><CardContent className="p-4"><h2 className="mb-3 font-bold text-white"><RotateCcw className="ml-2 inline h-4 w-4 text-[#F5B800]"/>تسجيل سداد جزئي أو كامل</h2><form className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" onSubmit={submitRepayment}>
      <label className="text-sm text-slate-300">مبلغ السداد<input required type="number" min="0.01" step="0.01" value={repayAmount} onChange={e=>setRepayAmount(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"/></label>
      <label className="text-sm text-slate-300">الحساب المستلم<select required value={repayAccount} onChange={e=>setRepayAccount(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"><option value="">اختر حساب الشركة</option>{accounts.data?.filter(a=>a.isActive).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label className="text-sm text-slate-300">تاريخ السداد<input required type="date" value={repayDate} onChange={e=>setRepayDate(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"/></label>
      <label className="text-sm text-slate-300">ملاحظات<input maxLength={500} value={repayNotes} onChange={e=>setRepayNotes(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-white/10 bg-[#0D1117] px-3 text-white"/></label>
      <div className="flex gap-2 sm:col-span-2 xl:col-span-4"><Button type="submit" disabled={repay.isPending} className="bg-[#F5B800] text-[#0D1117]">{repay.isPending?"جارٍ التسجيل…":"تأكيد السداد"}</Button><Button type="button" variant="outline" onClick={()=>setRepayId(null)} className="border-white/10 text-white">إلغاء</Button></div>
    </form></CardContent></Card>:null}
  </div>;
  return embedded?content:<DashboardLayout>{content}</DashboardLayout>;
}
