import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { getPowerHubConnectivitySnapshot, usePowerHubConnectivity } from "@/lib/offline-connectivity";
import { hasAuthoritativeServerRead } from "@/lib/authoritative-server-read";

const makeKey=()=> "supplier-source-correction:"+
  (typeof crypto!=="undefined" && typeof crypto.randomUUID==="function"
    ? crypto.randomUUID() : String(Date.now())+"-"+Math.random().toString(36).slice(2));

const positiveId=(v:string)=>{
  if(!/^[1-9][0-9]*$/.test(v.trim()))return 0;
  const n=Number(v.trim());
  return Number.isSafeInteger(n)?n:0;
};
const displayAmount=(v:unknown)=>{
  const n=Number(v);
  return Number.isFinite(n)?n.toLocaleString("ar-PS",{maximumFractionDigits:2}):"غير متاح";
};

export default function FinancialSupplierPaymentCorrectionWorkspace({
  siteId,isAuthenticated,selectedPaymentId,
}:{
  siteId:number;isAuthenticated:boolean;selectedPaymentId:number|null;
}){
  const {user}=useAuth();
  const {isOnline,isChecking}=usePowerHubConnectivity();
  const [expanded,setExpanded]=useState(false);
  const [paymentInput,setPaymentInput]=useState("");
  const [reason,setReason]=useState("");
  const [evidenceRef,setEvidenceRef]=useState("");
  const [requestConfirmed,setRequestConfirmed]=useState(false);
  const [reviewId,setReviewId]=useState<number|null>(null);
  const [reviewConfirmed,setReviewConfirmed]=useState(false);
  const [cursor,setCursor]=useState<number|undefined>();
  const [notice,setNotice]=useState("");
  const key=useRef(makeKey());
  const utils=trpc.useUtils();
  const reachable=isOnline&&!isChecking&&getPowerHubConnectivitySnapshot()===true;
  useEffect(()=>{
    if(selectedPaymentId && Number.isSafeInteger(selectedPaymentId) && selectedPaymentId>0){
      setExpanded(true);
      setPaymentInput(String(selectedPaymentId));
      setReason("");setEvidenceRef("");setRequestConfirmed(false);
      key.current=makeKey();
      setNotice("");
    }
  },[selectedPaymentId]);
  useEffect(()=>{
    setCursor(undefined);setReviewId(null);setReviewConfirmed(false);
    setPaymentInput("");setRequestConfirmed(false);setNotice("");
  },[siteId]);
  const enabled=expanded&&isAuthenticated&&siteId>0&&reachable;
  const access=trpc.powerhub.staff.myAccess.useQuery({siteId},{
    enabled,staleTime:0,refetchOnWindowFocus:false,
  });
  const canManage=enabled&&hasAuthoritativeServerRead(access)
    &&access.data?.permissions.includes("manageSupplierPayments")===true
    &&access.data?.permissions.includes("reverseSupplierPayments")===true
    &&access.data?.permissions.includes("viewFinancialReports")===true;
  const paymentId=positiveId(paymentInput);
  const readiness=trpc.powerhub.reports.financialSupplierPaymentCorrectionReadiness.useQuery({
    siteId,paymentId:paymentId||1,
  },{enabled:canManage&&paymentId>0,staleTime:0,refetchOnWindowFocus:false});
  const sourceReady=canManage&&paymentId>0&&hasAuthoritativeServerRead(readiness)
    &&readiness.data?.siteId===siteId
    &&readiness.data?.paymentId===paymentId
    &&readiness.data?.sourceEvidenceVerified===true
    &&readiness.data?.status==="SOURCE_VERIFIED_WORKFLOW_NOT_IMPLEMENTED"
    &&readiness.data?.accountingCertification==="NOT_CERTIFIED";
  const pending=trpc.powerhub.reports.financialSupplierPaymentCorrectionPending.useQuery({
    siteId,...(cursor?{beforeId:cursor}:{}),
  },{enabled:canManage,staleTime:0,refetchOnWindowFocus:false});
  const pendingReady=canManage&&hasAuthoritativeServerRead(pending)
    &&pending.data?.siteId===siteId
    &&pending.data?.accountingCertification==="NOT_CERTIFIED";
  const refreshFinancial=async()=>{
    await Promise.all([
      utils.powerhub.reports.financialSupplierPaymentCorrectionPending.invalidate(),
      utils.powerhub.reports.financialSupplierPaymentCorrectionReadiness.invalidate(),
      utils.powerhub.inventory.listSupplierPaymentHistory.invalidate(),
      utils.powerhub.inventory.supplierLedgerStatement.invalidate(),
      utils.powerhub.inventory.supplierPayablesAging.invalidate(),
      utils.powerhub.reports.financialGLCompanyMovementAudit.invalidate(),
      utils.powerhub.reports.financialGLSourceCoverage.invalidate(),
      utils.powerhub.reports.financialGLCorrectionReadiness.invalidate(),
    ]);
  };
  const request=trpc.powerhub.reports.financialSupplierPaymentCorrectionRequest.useMutation({
    onSuccess:async result=>{
      setNotice(result.alreadyPosted
        ?"التصحيح مسجل سابقًا، لم يُنشأ قيد جديد."
        :"حُفظ طلب التصحيح للمراجعة المستقلة؛ لم يحدث عكس أو قيد جديد.");
      setRequestConfirmed(false);
      await refreshFinancial();
    },
    onError:()=>{
      setNotice("لم يُؤكد حفظ الطلب. تحقق من قائمة الطلبات قبل إعادة المحاولة بنفس المفتاح.");
      void pending.refetch();
    },
  });
  const approve=trpc.powerhub.reports.financialSupplierPaymentCorrectionApprovePost.useMutation({
    onSuccess:async result=>{
      setNotice(result.alreadyPosted
        ?"الاعتماد موجود وتم إثبات القيد الأصلي دون تكرار."
        :"اكتمل التصحيح بمصدر عكسي وقيد GL مقابل وحركة رد، دون اعتماد القوائم المالية.");
      setReviewId(null);setReviewConfirmed(false);
      await refreshFinancial();
    },
    onError:()=>{
      setNotice("لم يُؤكد الاعتماد. أعِد جلب الحالة قبل تكرار الطلب.");
      void pending.refetch();
    },
  });
  const fullReason="مرجع مستند استرداد المورد: "+evidenceRef.trim()+"؛ السبب: "+reason.trim();
  const canRequest=sourceReady&&reachable&&requestConfirmed
    &&evidenceRef.trim().length>=8&&evidenceRef.trim().length<=120
    &&reason.trim().length>=10&&fullReason.length<=500
    &&!request.isPending&&!approve.isPending;
  const resetKey=()=>{
    key.current=makeKey();setRequestConfirmed(false);setNotice("");
  };
  return <section dir="rtl" className="rounded-lg border p-4 space-y-3" aria-label="تصحيح دفعات الموردين المرتبطة بدفتر الأستاذ">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 className="font-semibold">تصحيح دفعة مورد مرحّلة إلى GL — B4.16</h3>
        <p className="text-xs text-muted-foreground">طلب موثق ثم اعتماد مستقل. لا يُعد عكسًا عامًا أو اعتمادًا للقوائم المالية.</p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={()=>setExpanded(v=>!v)}>
        {expanded?"إخفاء التصحيح المحاسبي":"فتح تصحيح GL"}
      </Button>
    </div>
    {expanded?<div className="space-y-3">
      {!reachable?<p role="status" className="text-sm text-amber-700">
        هذا إجراء مالي عبر الخادم فقط؛ يلزم اتصال موثوق ولن تُرسل عمليات اعتماد دون اتصال.
      </p>:null}
      {enabled&&access.isError?<p role="alert" className="text-sm text-destructive">
        فشل التحقق من صلاحياتك؛ حُجبت العمليات والبيانات المالية.
      </p>:null}
      {enabled&&access.isSuccess&&!canManage?<p role="status" className="text-sm text-muted-foreground">
        يلزم عرض التقارير المالية وإدارة وعكس دفعات الموردين. لا تتاح عمليات التصحيح لهذا الحساب.
      </p>:null}
      {canManage?<div className="space-y-4">
        <div className="space-y-2 border rounded-md p-3">
          <label className="block text-sm font-medium">رقم دفعة المورد المراد مراجعتها
            <Input value={paymentInput} dir="ltr" inputMode="numeric"
              onChange={e=>{setPaymentInput(e.target.value);resetKey();}}
              placeholder="رقم دفعة المورد" aria-label="رقم دفعة المورد"/>
          </label>
          {paymentId>0&&readiness.isFetching?<p role="status" className="text-sm">جارٍ التحقق من المصدر والقيد…</p>:null}
          {paymentId>0&&readiness.isError?<p role="alert" className="text-sm text-destructive">
            تعذّر إثبات المستند والقيد؛ لا يمكن إنشاء طلب تصحيح.
          </p>:null}
          {paymentId>0&&hasAuthoritativeServerRead(readiness)&&!sourceReady
            ?<p className="text-sm text-amber-700">
              المصدر غير مؤهل لطلب B4.16 في هذه الحالة؛ حالة الفحص: {readiness.data?.status??"غير متاحة"}.
            </p>:null}
          {sourceReady?<div className="space-y-2">
            <p className="text-sm text-emerald-700">المصدر الأصلي مطابق. GL رقم {readiness.data?.originalGLEntryId}، المبلغ {displayAmount(readiness.data?.paymentAmount)} شيكل.</p>
            <label className="block text-sm">مرجع سند استرداد المبلغ الفعلي من المورد
              <Input maxLength={120} value={evidenceRef}
                onChange={e=>{setEvidenceRef(e.target.value);resetKey();}}
                placeholder="مرجع مستند الاسترداد، لا رقمًا صوريًا"/>
            </label>
            <label className="block text-sm">سبب طلب التصحيح
              <Input maxLength={320} value={reason}
                onChange={e=>{setReason(e.target.value);resetKey();}}
                placeholder="اشرح الخطأ وسبب الاسترداد"/>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={requestConfirmed}
                onChange={e=>setRequestConfirmed(e.target.checked)}/>
              أؤكد أن استرداد المبلغ موثق فعلًا، وأن هذا طلب مراجعة وليس اعتمادًا ماليًا.
            </label>
            <Button type="button" disabled={!canRequest} onClick={()=>{
              if(!canRequest||getPowerHubConnectivitySnapshot()!==true)return;
              request.mutate({siteId,paymentId,reason:fullReason,operationKey:key.current});
            }}>{request.isPending?"جارٍ حفظ الطلب…":"إعداد طلب تصحيح المورد"}</Button>
          </div>:null}
        </div>
        <div className="space-y-3 border rounded-md p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-semibold">طلبات تنتظر اعتماد مستخدم مستقل</h4>
            <Button type="button" size="sm" variant="outline" onClick={()=>void pending.refetch()} disabled={pending.isFetching}>تحديث من الخادم</Button>
          </div>
          {pending.isFetching?<p role="status" className="text-sm">جارٍ تحديث الطلبات…</p>:null}
          {pending.isError?<p role="alert" className="text-sm text-destructive">تعذّر التحقق من الطلبات؛ حُجبت الموافقات.</p>:null}
          {pendingReady&&!pending.isFetching&&pending.data?.items.length===0?<p className="text-sm text-muted-foreground">لا توجد طلبات معلقة في هذه الصفحة.</p>:null}
          {pendingReady&&!pending.isFetching?pending.data?.items.map(item=>{
            const self=Number(user?.id)===item.requestedByUserId;
            return <div className="border rounded-md p-3 space-y-2" key={item.correctionId}>
              <p className="font-medium">طلب #{item.correctionId} — دفعة #{item.paymentId} — {displayAmount(item.amount)} شيكل</p>
              <p className="text-xs text-muted-foreground">GL الأصلي #{item.originalGLEntryId} — أعدّه المستخدم #{item.requestedByUserId}</p>
              <p className="text-sm whitespace-pre-wrap">{item.reason}</p>
              {self?<p className="text-xs text-amber-700">لا تستطيع اعتماد طلب أعددته بنفسك.</p>:null}
              {!self&&reviewId===item.correctionId?<div className="space-y-2">
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={reviewConfirmed}
                    onChange={e=>setReviewConfirmed(e.target.checked)}/>
                  تحققت كمراجع مستقل من سند الاسترداد والمبلغ والحساب والمصدر الأصلي، وأوافق على التصحيح الذري.
                </label>
                <Button type="button" disabled={!reviewConfirmed||!reachable||approve.isPending||request.isPending}
                  onClick={()=>{
                    if(!reviewConfirmed||!reachable||getPowerHubConnectivitySnapshot()!==true)return;
                    approve.mutate({siteId,correctionId:item.correctionId,confirmIndependentReview:true});
                  }}>{approve.isPending?"جارٍ اعتماد التصحيح…":"اعتماد التصحيح الموثق"}</Button>
              </div>:!self?<Button type="button" size="sm" variant="outline"
                onClick={()=>{setReviewId(item.correctionId);setReviewConfirmed(false);setNotice("");}}>
                مراجعة الطلب</Button>:null}
            </div>;
          }):null}
          {pendingReady&&pending.data?.hasMore?<Button type="button" variant="outline" size="sm"
            onClick={()=>setCursor(pending.data?.nextBeforeId??undefined)}>عرض طلبات أقدم</Button>:null}
        </div>
        {notice?<p role="status" className="text-sm font-medium">{notice}</p>:null}
        <p className="text-xs text-amber-700">القبول المالي النهائي مستقل. قد يُرفض الطلب عند إغلاق الفترة أو اختلاف المصدر حتى لو ظهر في القائمة.</p>
      </div>:null}
    </div>:null}
  </section>;
}
