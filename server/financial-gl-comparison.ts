/** GL period comparison: validate the complete, scope-bound PostgreSQL response. */
type Data = Record<string, unknown>;
export class InvalidGLComparison extends Error {
  constructor(reason: string) { super(reason); this.name="InvalidGLComparison"; }
}
const object = (x: unknown): Data => {
  if (!x || typeof x!=="object" || Array.isArray(x))
    throw new InvalidGLComparison("INVALID_GL_COMPARISON_OBJECT");
  return x as Data;
};
const amount = (x: unknown): number => {
  if (x===null || x===undefined || x==="" || typeof x==="boolean")
    throw new InvalidGLComparison("MISSING_GL_AMOUNT");
  const v=Number(x);
  if (!Number.isFinite(v) || !Number.isSafeInteger(Math.round(v*100)) ||
      Math.abs(v*100-Math.round(v*100))>0.00001)
    throw new InvalidGLComparison("INVALID_GL_AMOUNT");
  return Math.round(v*100)/100;
};
const periodRe=/^\d{4}-(0[1-9]|1[0-2])$/;
export function previousGLMonth(period: string): string {
  if (!periodRe.test(period) || period.slice(0,4)==="0000")
    throw new InvalidGLComparison("INVALID_GL_MONTH");
  const [y,m]=period.split("-").map(Number);
  return new Date(Date.UTC(y,m-2,1)).toISOString().slice(0,7);
}
const metricNames = [
  "serviceRevenue","directServiceCost","grossResult","wages",
  "depreciation","provisions","otherOperatingExpenses","operatingResult",
  "nonOperatingExpenses","provisionalNetResult",
] as const;
type Account = {code:string;name:string;accountClass:string;current:number;previous:number;delta:number;percentage:number|null};
function percentChange(current: number,previous: number): number|null {
  return previous===0 ? null : Math.round((current-previous)/Math.abs(previous)*10000)/100;
}
function statement(raw: unknown,tenantId:number,siteId:number,period:string) {
  const s=object(raw),income=object(s.incomeStatement),sheet=object(s.balanceSheet);
  if(s.tenantId!==tenantId||s.siteId!==siteId||s.period!==period||
     s.siteScope!=="SITE_ONLY"||s.accountingBasis!=="POSTED_GL_ACCRUAL"||
     s.accountingCertification!=="NOT_CERTIFIED"||s.isFinalProfit!==false||
     s.isFinalBalanceSheet!==false||s.isCompleteAccrualStatement!==false||
     s.isMathematicallyBalanced!==true||sheet.isFinalBalanceSheet!==false||
     amount(sheet.equationDifference)!==0||income.isFinalProfit!==false||
     !Number.isSafeInteger(s.glEntryCount)||!Array.isArray(s.accounts)||
     typeof s.isSourceCoverageComplete!=="boolean"||
     typeof s.hasPostedData!=="boolean"||
     !Number.isSafeInteger(s.unreconciledSourceCount))
    throw new InvalidGLComparison("INVALID_GL_STATEMENT_SCOPE_OR_COMPLETENESS");
  const metrics=Object.fromEntries(metricNames.map(key=>[key,amount(income[key])])) as Record<typeof metricNames[number],number>;
  if (Math.abs(metrics.serviceRevenue-metrics.directServiceCost-metrics.grossResult)>0.001 ||
      Math.abs(metrics.operatingResult-metrics.nonOperatingExpenses-metrics.provisionalNetResult)>0.001)
    throw new InvalidGLComparison("INVALID_GL_INCOME_RECONCILIATION");
  const accounts=new Map<string,{name:string;accountClass:string;periodBalance:number}>();
  for(const value of s.accounts) {
    const a=object(value),code=a.code,name=a.name,accountClass=a.class;
    if(typeof code!=="string"||!/^\d{4,12}$/.test(code)||typeof name!=="string"||
       !name.trim()||!["asset","liability","equity","revenue","expense"].includes(String(accountClass))||
       accounts.has(code))
      throw new InvalidGLComparison("INVALID_OR_DUPLICATED_GL_ACCOUNT");
    accounts.set(code,{name,accountClass:String(accountClass),periodBalance:amount(a.periodBalance)});
  }
  const revenues=Array.from(accounts.values()).filter(a=>a.accountClass==="revenue")
    .reduce((sum,a)=>sum+a.periodBalance,0);
  if(Math.abs(revenues-metrics.serviceRevenue)>0.001)
    throw new InvalidGLComparison("GL_REVENUE_SOURCE_MISMATCH");
  return {metrics,accounts,periodStart:String(s.periodStart),periodEnd:String(s.periodEnd),
    glEntryCount:s.glEntryCount as number,
    hasPostedData:s.hasPostedData as boolean,
    isSourceCoverageComplete:s.isSourceCoverageComplete as boolean,
    unreconciledSourceCount:s.unreconciledSourceCount as number};
}
export function validateGLMonthlyComparison(
  raw: unknown, scope:{tenantId:number;siteId:number;currentPeriod:string;previousPeriod:string},
  expectedFingerprint?:string,
) {
  const d=object(raw);
  if(!periodRe.test(scope.currentPeriod)||!periodRe.test(scope.previousPeriod)||
     scope.currentPeriod<=scope.previousPeriod||scope.previousPeriod.slice(0,4)==="0000"||
     d.tenantId!==scope.tenantId||d.siteId!==scope.siteId||
     d.currentPeriod!==scope.currentPeriod||d.previousPeriod!==scope.previousPeriod||
     d.accountingBasis!=="POSTED_GL_ACCRUAL"||
     d.accountingCertification!=="NOT_CERTIFIED"||d.isFinalFinancialStatement!==false||
     d.sourceSnapshotAtomic!==true||d.periodTimeZone!=="Asia/Gaza"||
     d.currency!=="ILS"||typeof d.tenantName!=="string"||
     typeof d.siteName!=="string"||
     typeof d.snapshotFingerprint!=="string"||
     !/^[0-9a-f]{32}$/.test(d.snapshotFingerprint)||
     !Number.isFinite(Date.parse(String(d.generatedAt)))||
     !["BLOCKED","COMPARABLE_PRELIMINARY"].includes(String(d.status))||
     typeof d.canExport!=="boolean"||!Array.isArray(d.blockers)||
     !d.blockers.every((x:unknown)=>typeof x==="string"))
    throw new InvalidGLComparison("INVALID_GL_COMPARISON_PROVENANCE");
  if(expectedFingerprint && d.snapshotFingerprint!==expectedFingerprint)
    throw new InvalidGLComparison("GL_SOURCE_SNAPSHOT_CHANGED");
  const current=statement(d.current,scope.tenantId,scope.siteId,scope.currentPeriod);
  const previous=statement(d.previous,scope.tenantId,scope.siteId,scope.previousPeriod);
  const blockers=d.blockers as string[];
  const compatible=typeof d.recognitionPolicyVersion==="string" &&
     d.recognitionPolicyVersion.length>0 &&
     d.currentRecognitionPolicyVersion===d.recognitionPolicyVersion &&
     d.previousRecognitionPolicyVersion===d.recognitionPolicyVersion;
  const clear=current.hasPostedData&&previous.hasPostedData&&
    current.isSourceCoverageComplete&&previous.isSourceCoverageComplete&&
    current.unreconciledSourceCount===0&&previous.unreconciledSourceCount===0&&compatible;
  if((d.status==="COMPARABLE_PRELIMINARY")!==clear||
     d.canExport!==clear||(blockers.length===0)!==clear)
    throw new InvalidGLComparison("GL_COMPARISON_STATUS_CONTRADICTS_SOURCE");
  const metrics=metricNames.map(key=>{
    const currentValue=current.metrics[key],previousValue=previous.metrics[key];
    return {key,current:currentValue,previous:previousValue,
      delta:Math.round((currentValue-previousValue)*100)/100,
      percentage:percentChange(currentValue,previousValue)};
  });
  const codes=new Set([...current.accounts.keys(),...previous.accounts.keys()]);
  const accountRows:Account[]=Array.from(codes).sort().map(code=>{
    const c=current.accounts.get(code),p=previous.accounts.get(code);
    if(c&&p&&(c.name!==p.name||c.accountClass!==p.accountClass))
      throw new InvalidGLComparison("GL_ACCOUNT_METADATA_CHANGED");
    const a=c??p!,currentValue=c?.periodBalance??0,previousValue=p?.periodBalance??0;
    return {code,name:a.name,accountClass:a.accountClass,current:currentValue,
      previous:previousValue,delta:Math.round((currentValue-previousValue)*100)/100,
      percentage:percentChange(currentValue,previousValue)};
  });
  return {
    tenantId:scope.tenantId,siteId:scope.siteId,
    tenantName:d.tenantName as string,siteName:d.siteName as string,
    currentPeriod:scope.currentPeriod,previousPeriod:scope.previousPeriod,
    currentPeriodStart:current.periodStart,currentPeriodEnd:current.periodEnd,
    previousPeriodStart:previous.periodStart,previousPeriodEnd:previous.periodEnd,
    currentReviewStatus:String(d.currentReviewStatus),
    previousReviewStatus:String(d.previousReviewStatus),
    recognitionPolicyVersion:d.recognitionPolicyVersion as string|null,
    currentRecognitionPolicyVersion:d.currentRecognitionPolicyVersion as string|null,
    previousRecognitionPolicyVersion:d.previousRecognitionPolicyVersion as string|null,
    currency:"ILS" as const,periodTimeZone:"Asia/Gaza" as const,
    generatedAt:String(d.generatedAt),snapshotFingerprint:d.snapshotFingerprint as string,
    status:d.status as "BLOCKED"|"COMPARABLE_PRELIMINARY",
    canExport:clear,blockers,accountingCertification:"NOT_CERTIFIED" as const,
    isFinalFinancialStatement:false as const,
    currentGLEntryCount:current.glEntryCount,previousGLEntryCount:previous.glEntryCount,
    metrics,accountRows,
  };
}
