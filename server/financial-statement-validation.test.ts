import {describe,expect,it} from "vitest";
import {
  IncompleteFinancialStatement,verifyPostedJournalLines,verifyBalanceSheet,
  compareCertifiedPeriods,type LedgerLine
} from "./financial-statement-validation";
const pair:LedgerLine[]=[
  {entryId:"A",accountCode:"1100",accountClass:"asset",side:"debit",minorUnits:10000n},
  {entryId:"A",accountCode:"4100",accountClass:"revenue",side:"credit",minorUnits:10000n},
];
describe("financial phase2 acceptance gates",()=>{
  it("balances independently grouped postings and account balances",()=>{
    expect(verifyPostedJournalLines(pair,true)).toEqual({
      postedEntries:1,accounts:2,debitBalances:10000n,creditBalances:10000n,
    });
  });
  it("fails closed on missing sources, empty ledger, unbalanced entry and conflicting account class",()=>{
    expect(()=>verifyPostedJournalLines(pair,false)).toThrow("MISSING_JOURNAL_SOURCE");
    expect(()=>verifyPostedJournalLines([],true)).toThrow("NO_POSTED_JOURNAL_LINES");
    expect(()=>verifyPostedJournalLines(pair.slice(0,1),true)).toThrow("UNBALANCED_ENTRY");
    expect(()=>verifyPostedJournalLines([...pair,{...pair[0],accountClass:"liability"}],true))
      .toThrow("ACCOUNT_CLASS_CONFLICT");
  });
  it("rejects invalid amounts and account codes instead of inventing totals",()=>{
    expect(()=>verifyPostedJournalLines([{...pair[0],minorUnits:0n},pair[1]],true))
      .toThrow("ZERO_ENTRY_AMOUNT");
    expect(()=>verifyPostedJournalLines([{...pair[0],minorUnits:-1n},pair[1]],true))
      .toThrow("NEGATIVE_ENTRY_AMOUNT");
    expect(()=>verifyPostedJournalLines([{...pair[0],accountCode:""},pair[1]],true))
      .toThrow("MISSING_POSTING_IDENTITY");
  });
  it("does not call an arithmetic identity a complete balance sheet",()=>{
    expect(verifyBalanceSheet({
      assets:15000n,liabilities:5000n,equity:10000n,
      statementSourceComplete:true,openingBalancesReconciled:true,
    })).toEqual({balanced:true,difference:0n});
    expect(()=>verifyBalanceSheet({
      assets:15000n,liabilities:5000n,equity:10000n,
      statementSourceComplete:false,openingBalancesReconciled:true,
    })).toThrow("INCOMPLETE_BALANCE_SHEET_SOURCES");
    expect(()=>verifyBalanceSheet({
      assets:15000n,liabilities:5000n,equity:10000n,
      statementSourceComplete:true,openingBalancesReconciled:false,
    })).toThrow("UNRECONCILED_OPENING_BALANCES");
    expect(()=>verifyBalanceSheet({
      assets:15001n,liabilities:5000n,equity:10000n,
      statementSourceComplete:true,openingBalancesReconciled:true,
    })).toThrow("BALANCE_SHEET_MISMATCH");
  });
  it("blocks inconsistent or incomplete comparisons and handles zero baseline",()=>{
    const options={currentComplete:true,previousComplete:true,
      currentPolicyVersion:"service-v1",previousPolicyVersion:"service-v1"};
    expect(compareCertifiedPeriods(15000n,10000n,options)).toEqual({
      change:5000n,percentageChange:50,
    });
    expect(compareCertifiedPeriods(1000n,0n,options).percentageChange).toBeNull();
    expect(()=>compareCertifiedPeriods(10n,5n,{...options,previousComplete:false}))
      .toThrow("INCOMPLETE_COMPARISON_PERIOD");
    expect(()=>compareCertifiedPeriods(10n,5n,{...options,previousPolicyVersion:"service-v2"}))
      .toThrow("RECOGNITION_POLICY_MISMATCH");
  });
  it("uses the explicit accounting exception type",()=>{
    expect(new IncompleteFinancialStatement("TEST").name).toBe("IncompleteFinancialStatement");
  });
});
