/**
 * Pure financial snapshot aggregation. No DB calls and no caller-controlled tenant or
 * authorization scope: the server supplies only snapshots for independently authorized sites.
 */
export const FINANCIAL_SITE_TOTALS = [
  "supplierPayables", "supplierPrepayments", "employeeAdvances",
  "subscriberReceivables", "inventoryValue", "subscriberCreditLiability",
  "securityDepositLiability", "approvedPayrollPayable",
] as const;

type TotalKey = typeof FINANCIAL_SITE_TOTALS[number];
export type SiteFinancialSnapshot = {
  siteId: number;
  siteName: string;
  position: Record<string, unknown>;
};
export class InvalidFinancialSnapshot extends Error {
  constructor(message: string) { super(message); this.name = "InvalidFinancialSnapshot"; }
}
const finite = (data: Record<string, unknown>, field: string) => {
  const raw = data[field];
  if (raw === undefined || raw === null || raw === "" || typeof raw === "boolean") {
    throw new InvalidFinancialSnapshot(`Missing financial field: ${field}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new InvalidFinancialSnapshot(`Invalid financial field: ${field}`);
  return value;
};
export function aggregateAuthorizedFinancialPositions(snapshots: SiteFinancialSnapshot[]) {
  if (snapshots.length < 2 || snapshots.length > 40) throw new InvalidFinancialSnapshot("Invalid site count");
  const totals = Object.fromEntries(FINANCIAL_SITE_TOTALS.map(key => [key,0])) as Record<TotalKey,number>;
  const accountBalances = new Map<number,{balance:number;shared:boolean}>();
  const seenSites = new Set<number>();
  const branches: Array<{siteId:number;siteName:string;subscriberReceivables:number;inventoryValue:number;supplierPayables:number}> = [];
  for (const {siteId,siteName,position} of snapshots) {
    if (!Number.isSafeInteger(siteId) || siteId <= 0 || seenSites.has(siteId) ||
        finite(position,"scopeSiteId") !== siteId) {
      throw new InvalidFinancialSnapshot("Duplicate or out-of-scope site");
    }
    seenSites.add(siteId);
    if (finite(position,"inventoryValuationIssueCount") !== 0 ||
        finite(position,"subscriberLiabilityIssueCount") !== 0) {
      throw new InvalidFinancialSnapshot("Unreconciled inventory or subscriber liability");
    }
    for (const key of FINANCIAL_SITE_TOTALS) totals[key] += finite(position,key);
    if (!Array.isArray(position.accounts)) throw new InvalidFinancialSnapshot("Missing financial accounts");
    const inThisSite = new Set<number>();
    for (const item of position.accounts) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new InvalidFinancialSnapshot("Invalid account");
      const account = item as Record<string,unknown>;
      const id = finite(account,"id"), balance = finite(account,"balance");
      if (!Number.isSafeInteger(id) || id <= 0 || inThisSite.has(id)) {
        throw new InvalidFinancialSnapshot("Invalid or repeated account ID");
      }
      inThisSite.add(id);
      const prior = accountBalances.get(id);
      if (prior && Math.abs(prior.balance-balance) > 0.000001) {
        throw new InvalidFinancialSnapshot("Conflicting shared-account balances");
      }
      accountBalances.set(id,{balance,shared:account.shared===true || Boolean(prior?.shared)});
    }
    branches.push({
      siteId,siteName,
      subscriberReceivables:finite(position,"subscriberReceivables"),
      inventoryValue:finite(position,"inventoryValue"),
      supplierPayables:finite(position,"supplierPayables"),
    });
  }
  const cashBalance = Array.from(accountBalances.values()).reduce((sum,a)=>sum+a.balance,0);
  if (![cashBalance,...Object.values(totals)].every(Number.isFinite)) {
    throw new InvalidFinancialSnapshot("Financial aggregate overflow");
  }
  return {
    branchCount:snapshots.length,
    cashBalance, accountCount:accountBalances.size,
    sharedAccountCount:Array.from(accountBalances.values()).filter(a=>a.shared).length,
    ...totals,branches,
    scopeNotice:"authorized_sites_only" as const,
    isCompleteBalanceSheet:false as const,
  };
}
