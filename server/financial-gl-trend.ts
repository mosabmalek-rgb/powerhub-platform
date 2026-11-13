/** Fail-closed validation for the on-demand PostgreSQL GL month x site cube. */
export class InvalidGLTrend extends Error {
  constructor(message:string){super(message);this.name="InvalidGLTrend";}
}
type Input = {tenantId:number;siteIds:number[];endPeriod:string;months:number;allSites:boolean};
const periodPattern=/^\d{4}-(0[1-9]|1[0-2])$/;
const finite=(x:unknown):number=>{
 if(x===null||x===undefined||x===""||typeof x==="boolean")
  throw new InvalidGLTrend("MISSING_AMOUNT");
 const n=Number(x);
 if(!Number.isFinite(n)||!Number.isSafeInteger(Math.round(n*100))||
    Math.abs(n*100-Math.round(n*100))>0.00001)
  throw new InvalidGLTrend("INVALID_AMOUNT");
 return Math.round(n*100)/100;
};
export function glTrendPeriods(end:string,months:number):string[]{
 if(!periodPattern.test(end)||end.startsWith("0000-")||
   !Number.isInteger(months)||months<1||months>12)
  throw new InvalidGLTrend("INVALID_MONTH_WINDOW");
 const [year,month]=end.split("-").map(Number);
 return Array.from({length:months},(_,i)=>{
  const d=new Date(Date.UTC(year,month-months+i,1));
  return d.toISOString().slice(0,7);
 });
}
export function validateGLTrend(raw:unknown,input:Input){
 if(!raw||typeof raw!=="object"||Array.isArray(raw))
  throw new InvalidGLTrend("INVALID_RESPONSE");
 const d=raw as Record<string,unknown>;
 const siteIds=[...input.siteIds].sort((a,b)=>a-b);
 if(siteIds.length<1||siteIds.length>30||new Set(siteIds).size!==siteIds.length||
    siteIds.some(id=>!Number.isSafeInteger(id)||id<=0)||
    !Number.isSafeInteger(input.tenantId)||input.tenantId<=0||
    (input.allSites&&siteIds.length<2)||(!input.allSites&&siteIds.length!==1))
  throw new InvalidGLTrend("INVALID_AUTHORIZED_SCOPE");
 const periods=glTrendPeriods(input.endPeriod,input.months);
 if(d.tenantId!==input.tenantId||d.siteCount!==siteIds.length||
    d.months!==input.months||d.endPeriod!==input.endPeriod||
    d.startPeriod!==periods[0]||typeof d.tenantName!=="string"||
    !Array.isArray(d.siteIds)||!Array.isArray(d.rows)||
    d.siteIds.length!==siteIds.length||
    siteIds.some(id=>!d.siteIds.includes(id))||
    d.rows.length!==siteIds.length*periods.length||
    d.source!=="POSTED_GL_FULL_PERIOD_AGGREGATES"||
    d.status!=="PRELIMINARY_GL_TREND_UNVERIFIED_SOURCES"||
    d.sourceCoverageVerified!==false||d.centralCostAllocationIncluded!==false||
    d.isConsolidatedFinancialStatement!==false||
    d.accountingCertification!=="NOT_CERTIFIED"||d.isFinalProfit!==false||
    d.periodTimeZone!=="Asia/Gaza"||d.currency!=="ILS"||
    d.sourceSnapshotAtomic!==true||
    !Number.isFinite(Date.parse(String(d.generatedAt))))
  throw new InvalidGLTrend("INVALID_TREND_PROVENANCE");
 const seen=new Set<string>();
 const rows=d.rows.map((value:unknown)=>{
  if(!value||typeof value!=="object"||Array.isArray(value))
   throw new InvalidGLTrend("INVALID_TREND_ROW");
  const r=value as Record<string,unknown>;
  const key=r.siteId+":"+r.period;
  if(typeof r.siteId!=="number"||!siteIds.includes(r.siteId)||
     !periods.includes(String(r.period))||seen.has(key)||
     typeof r.siteName!=="string"||!r.siteName.trim()||
     !Number.isSafeInteger(r.glEntryCount)||r.glEntryCount<0||
     r.hasPostedData!==(r.glEntryCount>0)||
     r.isFinalProfit!==false||r.isCompleteAccrualStatement!==false||
     !["SINGLE_VERSION","MIXED_POLICY","UNPROVEN"].includes(String(r.recognitionPolicyStatus)))
   throw new InvalidGLTrend("INVALID_TREND_ROW_SCOPE");
  if((r.recognitionPolicyStatus==="SINGLE_VERSION")!==
     (typeof r.recognitionPolicyVersion==="string"&&r.recognitionPolicyVersion.length>0))
   throw new InvalidGLTrend("INVALID_RECOGNITION_PROVENANCE");
  seen.add(key);
  const values=Object.fromEntries([
   "serviceRevenue","directServiceCost","grossResult","wages","depreciation",
   "provisions","nonOperatingExpenses","operatingResult","provisionalNetResult",
  ].map(k=>[k,finite(r[k])])) as Record<string,number>;
  if(Math.abs(values.serviceRevenue-values.directServiceCost-values.grossResult)>0.001||
     Math.abs(values.grossResult-values.wages-values.depreciation-
       values.provisions-values.operatingResult)>0.001||
     Math.abs(values.operatingResult-values.nonOperatingExpenses-values.provisionalNetResult)>0.001)
   throw new InvalidGLTrend("UNBALANCED_TREND_PROVENANCE");
  return {siteId:r.siteId as number,siteName:r.siteName as string,
   period:r.period as string,glEntryCount:r.glEntryCount as number,
   hasPostedData:r.hasPostedData as boolean,
   recognitionPolicyVersion:r.recognitionPolicyVersion as string|null,
   recognitionPolicyStatus:r.recognitionPolicyStatus as string,
   ...values};
 });
 for(const siteId of siteIds)for(const period of periods)
  if(!seen.has(siteId+":"+period))throw new InvalidGLTrend("INCOMPLETE_TREND_CUBE");
 return {tenantId:input.tenantId,tenantName:d.tenantName as string,
  siteIds,siteCount:siteIds.length,allSites:input.allSites,
  startPeriod:periods[0],endPeriod:input.endPeriod,months:periods.length,
  generatedAt:String(d.generatedAt),currency:"ILS" as const,
  accountingCertification:"NOT_CERTIFIED" as const,
  status:"PRELIMINARY_GL_TREND_UNVERIFIED_SOURCES" as const,
  sourceCoverageVerified:false as const,rows};
}
