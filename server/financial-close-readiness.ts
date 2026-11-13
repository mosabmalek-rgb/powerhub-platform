// C2: advisory, read-only financial month-end readiness. Never approves or locks.
export type FinancialCloseBlocker = { code: string; label: string; count: number | null };
export type FinancialCloseReadinessStatus =
  | "BLOCKED" | "REVIEW_REQUIRED" | "READY_FOR_INDEPENDENT_REVIEW" | "LOCKED_NOT_CERTIFIED";

const evidenceKeys = [
  "unbilled_service", "invoice_cutoff", "supplier_reconciliation",
  "inventory_reconciliation", "payroll_reconciliation", "depreciation_register",
  "provision_assessment", "tax_reconciliation",
] as const;

const countFields = [
  ["missingCycleCount", "MISSING_SERVICE_CYCLE", "فواتير دون دورة خدمة موثقة"],
  ["uncompletedInvoiceCount", "INCOMPLETE_SERVICE_CYCLE", "فواتير خدمة لم تكتمل"],
  ["draftPayrollCount", "DRAFT_PAYROLL", "مسيرات رواتب غير معتمدة"],
  ["unreconciledPayrollPayoutCount", "UNRECONCILED_PAYROLL_CASH", "دفعات رواتب غير متطابقة نقديًا"],
  ["unclassifiedInventoryIssueCount", "UNCLASSIFIED_STOCK_ISSUE", "حركات مخزون غير مصنفة محاسبيًا"],
  ["invalidInvoiceCount", "INVALID_INVOICE_SOURCE", "فواتير غير صالحة محاسبيًا"],
  ["invalidExpenseCount", "INVALID_EXPENSE_SOURCE", "مصروفات ذات مصدر غير صالح"],
  ["invalidPayrollCount", "INVALID_PAYROLL_SOURCE", "رواتب ذات مصدر غير صالح"],
  ["invalidInventoryCount", "INVALID_INVENTORY_SOURCE", "حركات مخزون غير صالحة"],
  ["crossPeriodInvoiceCount", "CROSS_PERIOD_INVOICE", "فواتير مرتبطة بفترة محاسبية أخرى"],
  ["issuedOutsideServiceMonthCount", "SERVICE_CUTOFF_REVIEW", "فواتير صدرت خارج شهر الخدمة"],
] as const;

function record(value: unknown): Record<string, unknown> {
  if (value===null || typeof value!=="object" || Array.isArray(value))
    throw new Error("C2_INVALID_SOURCE_SHAPE");
  return value as Record<string, unknown>;
}
function nonnegativeInteger(row: Record<string, unknown>, key: string): number {
  const n=row[key];
  if(typeof n!=="number" || !Number.isSafeInteger(n) || n<0)
    throw new Error("C2_INVALID_SOURCE_COUNT_"+key);
  return n;
}
function finiteNumber(row: Record<string, unknown>, key: string): number {
  const n=row[key];
  if(typeof n!=="number" || !Number.isFinite(n))
    throw new Error("C2_INVALID_SOURCE_AMOUNT_"+key);
  return n;
}
function currentGazaPeriod(now: Date): string {
  if(!Number.isFinite(now.getTime())) throw new Error("C2_INVALID_NOW");
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone:"Asia/Gaza",year:"numeric",month:"2-digit",
  }).formatToParts(now);
  const year=parts.find(p=>p.type==="year")?.value;
  const month=parts.find(p=>p.type==="month")?.value;
  if(!year||!month) throw new Error("C2_INVALID_GAZA_CALENDAR");
  return year+"-"+month;
}
export function buildFinancialCloseReadiness(input: {
  tenantId: number; siteId: number; period: string; now: Date;
  statement: unknown; review: unknown;
}) {
  const {tenantId,siteId,period,now}=input;
  if(!Number.isSafeInteger(tenantId)||tenantId<=0
    ||!Number.isSafeInteger(siteId)||siteId<=0
    ||!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
    throw new Error("C2_INVALID_SCOPE");
  const statement=record(input.statement),review=record(input.review);
  if(statement.scopeTenantId!==tenantId || statement.scopeSiteId!==siteId
    ||statement.period!==period || statement.isFinalProfit!==false
    ||statement.isCompleteAccrualStatement!==false ||review.isCertifiedProfit!==false
    ||!["unprepared","draft","locked"].includes(String(review.status)))
    throw new Error("C2_SCOPE_OR_CERTIFICATION_MISMATCH");
  if(typeof statement.asOf!=="string"||!Number.isFinite(Date.parse(statement.asOf)))
    throw new Error("C2_INVALID_SOURCE_AS_OF");
  const age=now.getTime()-Date.parse(statement.asOf);
  if(age>5*60*1000 || age< -5*60*1000)
    throw new Error("C2_STALE_OR_FUTURE_SOURCE");
  if((typeof review.driftDetected!=="undefined" && typeof review.driftDetected!=="boolean")
    || (review.status==="locked" && typeof review.driftDetected!=="boolean"))
    throw new Error("C2_INVALID_DRIFT_STATUS");
  const journal=record(statement.journalAdjustments);
  const debit=finiteNumber(journal,"balancedDebits");
  const credit=finiteNumber(journal,"balancedCredits");
  const draftJournals=nonnegativeInteger(journal,"draftCount");
  nonnegativeInteger(journal,"postedCount");
  if(!Array.isArray(statement.limitations) || statement.limitations.length===0
    ||statement.limitations.some(s=>typeof s!=="string"||!s.trim()))
    throw new Error("C2_MISSING_FINANCIAL_LIMITATIONS");
  const blockers: FinancialCloseBlocker[]=[];
  const add=(code:string,label:string,count:number|null=null)=>{
    blockers.push({code,label,count});
  };
  if(period>=currentGazaPeriod(now))
    add("PERIOD_NOT_ENDED","لم تنتهِ الفترة المحاسبية بعد");
  for(const [field,code,label] of countFields){
    const count=nonnegativeInteger(statement,field);
    if(count>0) add(code,label,count);
  }
  if(draftJournals>0)
    add("DRAFT_ADJUSTMENTS","قيود تسوية بانتظار الاعتماد",draftJournals);
  if(Math.abs(debit-credit)>0.009)
    add("UNBALANCED_ADJUSTMENTS","اختلاف إجمالي المدين والدائن");
  if(review.driftDetected===true)
    add("SOURCE_DRIFT_AFTER_REVIEW","تغيرت المصادر بعد تسجيل مراجعة الفترة");
  const reviewRequirements:{code:string;label:string}[]=[];
  if(review.status==="unprepared")
    reviewRequirements.push({code:"REVIEW_NOT_PREPARED",label:"يجب إعداد مستندات المراجعة الشهرية أولًا"});
  if(review.status==="draft"){
    if(!Number.isSafeInteger(review.preparedByUserId)||Number(review.preparedByUserId)<=0)
      throw new Error("C2_REVIEW_PREPARER_MISSING");
    const evidence=review.evidence===null||review.evidence===undefined
      ? {} : record(review.evidence);
    const missing=evidenceKeys.filter(key=>
      typeof evidence[key]!=="string" || String(evidence[key]).trim().length<8);
    if(missing.length>0)
      reviewRequirements.push({
        code:"INCOMPLETE_DOCUMENTARY_REVIEW",
        label:"مستندات المراجعة غير مكتملة في "+missing.length+" بنود",
      });
  }
  const status:FinancialCloseReadinessStatus=blockers.length>0
    ? "BLOCKED"
    : review.status==="locked" ? "LOCKED_NOT_CERTIFIED"
    : reviewRequirements.length>0 ? "REVIEW_REQUIRED"
    : "READY_FOR_INDEPENDENT_REVIEW";
  return {
    tenantId,siteId,period,status,blockers,reviewRequirements,
    reviewStatus:review.status as "draft"|"locked"|"unprepared",
    sourceAsOf:statement.asOf,
    sourceLimitations:statement.limitations as string[],
    sourceSnapshotAtomic:false as const,
    requiresLiveRevalidationAtLock:true as const,
    needsIndependentReviewer:true as const,
    canAutomaticallyLock:false as const,
    isFinalFinancialStatement:false as const,
    accountingCertification:"NOT_CERTIFIED" as const,
  };
}
