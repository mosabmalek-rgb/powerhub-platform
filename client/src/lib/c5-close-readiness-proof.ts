// Pure C5 response validator; safe for the browser and Node contract tests.
// No credentials, financial amounts or source documents are returned.
export type C5Decision =
  | "BLOCKED"
  | "REVIEW_REQUIRED"
  | "READY_FOR_INDEPENDENT_REVIEW"
  | "LOCKED_NOT_CERTIFIED";
type C5Blocker = { code:string; label:string; count:number|null };
const accepted = new Set<C5Decision>([
  "BLOCKED","REVIEW_REQUIRED","READY_FOR_INDEPENDENT_REVIEW","LOCKED_NOT_CERTIFIED",
]);
const allowedBlockerCodes = new Set([
  "PERIOD_NOT_ENDED", "MISSING_SERVICE_CYCLE", "INCOMPLETE_SERVICE_CYCLE",
  "DRAFT_PAYROLL", "UNRECONCILED_PAYROLL_CASH", "UNCLASSIFIED_STOCK_ISSUE",
  "INVALID_INVOICE_SOURCE", "INVALID_EXPENSE_SOURCE", "INVALID_PAYROLL_SOURCE",
  "INVALID_INVENTORY_SOURCE", "CROSS_PERIOD_INVOICE", "SERVICE_CUTOFF_REVIEW",
  "DRAFT_ADJUSTMENTS", "UNBALANCED_ADJUSTMENTS", "SOURCE_DRIFT_AFTER_REVIEW",
]);
const allowedReviewCodes = new Set(["REVIEW_NOT_PREPARED","INCOMPLETE_DOCUMENTARY_REVIEW"]);

export function validateC5HttpResponse(
  status:number,
  raw:string,
  scope:{tenantId:number;siteId:number;period:string},
  expectedStatus:C5Decision,
):{fingerprint:string;decision:C5Decision;blockerCodes:string[]} {
  if(status!==200)throw new Error("HTTP_"+status);
  let value:Record<string,unknown>;
  try {
    const response=JSON.parse(raw);
    const candidate=response?.result?.data?.json;
    if(!candidate||typeof candidate!=="object"||Array.isArray(candidate))
      throw new Error("C5_RESPONSE_NOT_OBJECT");
    value=candidate as Record<string,unknown>;
  } catch {throw new Error("C5_INVALID_JSON_OR_RESPONSE");}
  if(value.tenantId!==scope.tenantId || value.siteId!==scope.siteId
    ||value.period!==scope.period
    ||value.accountingCertification!=="NOT_CERTIFIED"
    ||value.isFinalFinancialStatement!==false
    ||value.canAutomaticallyLock!==false
    ||value.sourceSnapshotAtomic!==false
    ||value.needsIndependentReviewer!==true
    ||value.requiresLiveRevalidationAtLock!==true)
    throw new Error("C5_SCOPE_OR_CERTIFICATION_DRIFT");
  if(typeof value.status!=="string" || !accepted.has(value.status as C5Decision)
    ||value.status!==expectedStatus)
    throw new Error("C5_UNEXPECTED_REVIEW_STATUS");
  if(!Array.isArray(value.blockers)||!Array.isArray(value.reviewRequirements)
    ||!Array.isArray(value.sourceLimitations)||value.sourceLimitations.length===0
    ||value.sourceLimitations.some(x=>typeof x!=="string"||!x.trim())
    ||typeof value.sourceAsOf!=="string"||!Number.isFinite(Date.parse(value.sourceAsOf)))
    throw new Error("C5_INVALID_SOURCE_EVIDENCE");
  if(!["unprepared","draft","locked"].includes(String(value.reviewStatus)))
    throw new Error("C5_INVALID_REVIEW_STATUS");
  const blockerCodes:string[]=[];
  const normalizeBlockers=(records:unknown[],known:Set<string>):C5Blocker[]=>{
    return records.map(rawItem=>{
      if(!rawItem || typeof rawItem!=="object" || Array.isArray(rawItem))
        throw new Error("C5_INVALID_BLOCKER_RECORD");
      const item=rawItem as Record<string,unknown>;
      if(typeof item.code!=="string"||!known.has(item.code)
        ||typeof item.label!=="string"||!item.label.trim()
        ||!("count" in item)
        ||(item.count!==null&&(typeof item.count!=="number"||!Number.isSafeInteger(item.count)||item.count<0)))
        throw new Error("C5_INVALID_BLOCKER_CONTENT");
      return {code:item.code,label:item.label,count:item.count as number|null};
    }).sort((a,b)=>a.code.localeCompare(b.code));
  };
  const blockers=normalizeBlockers(value.blockers,allowedBlockerCodes);
  blockerCodes.push(...blockers.map(b=>b.code));
  if(new Set(blockerCodes).size!==blockerCodes.length)
    throw new Error("C5_DUPLICATE_BLOCKER");
  // Review requirements do not carry an amount; still verify exactly expected shape.
  const requirements=(value.reviewRequirements as unknown[]).map(item=>{
    if(!item || typeof item!=="object" || Array.isArray(item))
      throw new Error("C5_INVALID_REVIEW_ITEM");
    const r=item as Record<string,unknown>;
    if(typeof r.code!=="string"||!allowedReviewCodes.has(r.code)
      ||typeof r.label!=="string"||!r.label.trim())
      throw new Error("C5_INVALID_REVIEW_REQUIREMENT");
    return {code:r.code,label:r.label};
  }).sort((a,b)=>a.code.localeCompare(b.code));
  if(new Set(requirements.map(x=>x.code)).size!==requirements.length)
    throw new Error("C5_DUPLICATE_REVIEW_REQUIREMENT");
  if(value.status==="BLOCKED" && blockers.length===0)
    throw new Error("C5_EMPTY_BLOCKED_RESULT");
  if(value.status==="READY_FOR_INDEPENDENT_REVIEW" &&
    (blockers.length>0||requirements.length>0||value.reviewStatus!=="draft"))
    throw new Error("C5_FALSE_READY_STATUS");
  if(value.status==="LOCKED_NOT_CERTIFIED" &&
    (value.reviewStatus!=="locked"||requirements.length>0))
    throw new Error("C5_FALSE_LOCKED_STATUS");
  // No financial data, evidence references, secrets or access-token data are retained.
  return {
    decision:value.status as C5Decision,
    blockerCodes,
    fingerprint:JSON.stringify({
      decision:value.status,review:value.reviewStatus,
      blockers:blockers.map(b=>[b.code,b.count]),
      requirements:requirements.map(r=>r.code),
    }),
  };
}

export function c5Quantile(values:readonly number[],q:number):number|null {
  if(q<0||q>1||!Number.isFinite(q))throw new Error("C5_INVALID_QUANTILE");
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b);
  if(sorted.some(x=>!Number.isFinite(x)||x<0))
    throw new Error("C5_INVALID_DURATION");
  return Math.round(sorted[Math.ceil(sorted.length*q)-1]*100)/100;
}
