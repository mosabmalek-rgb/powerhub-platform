/**
 * Fail-closed arithmetic checks for financial statement preparation.
 * This does NOT fetch source schedules or certify that a GL is complete.
 * A caller must prove source completeness separately.
 * Integer minor units (agorot/cents) avoid floating-point rounding drift.
 */
export type Side = "debit" | "credit";
export type AccountClass = "asset" | "liability" | "equity" | "revenue" | "expense";
export type LedgerLine = {
  entryId:string; accountCode:string; accountClass:AccountClass;
  side:Side; minorUnits:bigint;
};
export type Position = {
  assets:bigint; liabilities:bigint; equity:bigint;
  statementSourceComplete:boolean; openingBalancesReconciled:boolean;
};
export class IncompleteFinancialStatement extends Error {
  constructor(public readonly reason:string) {
    super(reason); this.name="IncompleteFinancialStatement";
  }
}
function assertNonnegative(value:bigint,field:string){
  if(value<0n)throw new IncompleteFinancialStatement("NEGATIVE_"+field);
}
export function verifyPostedJournalLines(lines:readonly LedgerLine[],sourceComplete:boolean){
  if(!sourceComplete)throw new IncompleteFinancialStatement("MISSING_JOURNAL_SOURCE");
  if(!lines.length)throw new IncompleteFinancialStatement("NO_POSTED_JOURNAL_LINES");
  const entries=new Map<string,{debit:bigint;credit:bigint}>();
  const trial=new Map<string,{accountClass:AccountClass;debit:bigint;credit:bigint}>();
  for(const line of lines){
    if(!line.entryId.trim()||!line.accountCode.trim())
      throw new IncompleteFinancialStatement("MISSING_POSTING_IDENTITY");
    if(!["asset","liability","equity","revenue","expense"].includes(line.accountClass))
      throw new IncompleteFinancialStatement("INVALID_ACCOUNT_CLASS");
    assertNonnegative(line.minorUnits,"ENTRY_AMOUNT");
    if(line.minorUnits===0n)throw new IncompleteFinancialStatement("ZERO_ENTRY_AMOUNT");
    if(line.side!=="debit"&&line.side!=="credit")
      throw new IncompleteFinancialStatement("INVALID_ENTRY_SIDE");
    const entry=entries.get(line.entryId)??{debit:0n,credit:0n};
    entry[line.side]+=line.minorUnits;entries.set(line.entryId,entry);
    const current=trial.get(line.accountCode)??{accountClass:line.accountClass,debit:0n,credit:0n};
    if(current.accountClass!==line.accountClass)
      throw new IncompleteFinancialStatement("ACCOUNT_CLASS_CONFLICT");
    current[line.side]+=line.minorUnits;trial.set(line.accountCode,current);
  }
  for(const entry of entries.values()){
    if(entry.debit!==entry.credit)throw new IncompleteFinancialStatement("UNBALANCED_ENTRY");
  }
  let debitBalances=0n,creditBalances=0n;
  for(const account of trial.values()){
    const net=account.debit-account.credit;
    if(net>=0n)debitBalances+=net;
    else creditBalances-=net;
  }
  if(debitBalances!==creditBalances)
    throw new IncompleteFinancialStatement("UNBALANCED_TRIAL_BALANCE");
  return {postedEntries:entries.size,accounts:trial.size,debitBalances,creditBalances};
}
export function verifyBalanceSheet(position:Position){
  if(!position.statementSourceComplete)
    throw new IncompleteFinancialStatement("INCOMPLETE_BALANCE_SHEET_SOURCES");
  if(!position.openingBalancesReconciled)
    throw new IncompleteFinancialStatement("UNRECONCILED_OPENING_BALANCES");
  const difference=position.assets-position.liabilities-position.equity;
  if(difference!==0n)
    throw new IncompleteFinancialStatement("BALANCE_SHEET_MISMATCH");
  return {balanced:true as const,difference};
}
export function compareCertifiedPeriods(current:bigint,previous:bigint,options:{
  currentComplete:boolean; previousComplete:boolean;
  currentPolicyVersion:string;previousPolicyVersion:string;
}){
  if(!options.currentComplete||!options.previousComplete)
    throw new IncompleteFinancialStatement("INCOMPLETE_COMPARISON_PERIOD");
  if(!options.currentPolicyVersion||options.currentPolicyVersion!==options.previousPolicyVersion)
    throw new IncompleteFinancialStatement("RECOGNITION_POLICY_MISMATCH");
  const change=current-previous;
  return {change,percentageChange:previous===0n?null:Number(change*10000n/(
    previous<0n?-previous:previous))/100};
}
