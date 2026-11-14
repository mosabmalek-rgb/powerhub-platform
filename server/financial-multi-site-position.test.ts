import { describe,expect,it } from "vitest";
import { aggregateAuthorizedFinancialPositions, InvalidFinancialSnapshot } from "./financial-multi-site-position";

const snapshot = (siteId:number,accounts: Array<{id:number;balance:string;shared?:boolean}>) => ({
  siteId,siteName:`Site ${siteId}`,
  position:{
    scopeSiteId:siteId,inventoryValuationIssueCount:0,subscriberLiabilityIssueCount:0,
    supplierPayables:"12.50",supplierPrepayments:"0",employeeAdvances:"0",
    subscriberReceivables:"10.25",inventoryValue:"30.75",
    subscriberCreditLiability:"0",securityDepositLiability:"0",
    approvedPayrollPayable:"0",accounts
  } as Record<string,unknown>
});
describe("authorized multi-site financial aggregation",()=>{
  it("counts shared accounts only once but adds branch-scoped balances",()=>{
    const result=aggregateAuthorizedFinancialPositions([
      snapshot(1,[{id:9,balance:"7170900.00",shared:true}]),
      snapshot(2,[{id:9,balance:"7170900.00",shared:true}]),
    ]);
    expect(result.cashBalance).toBe(7170900);
    expect(result.accountCount).toBe(1);
    expect(result.sharedAccountCount).toBe(1);
    expect(result.supplierPayables).toBe(25);
    expect(result.subscriberReceivables).toBe(20.5);
    expect(result.inventoryValue).toBe(61.5);
  });
  it("preserves different accounts across branches",()=>{
    const result=aggregateAuthorizedFinancialPositions([
      snapshot(1,[{id:1,balance:"100"}]),snapshot(2,[{id:2,balance:"50"}])
    ]);
    expect(result.cashBalance).toBe(150);
    expect(result.accountCount).toBe(2);
  });
  it("fails closed on inconsistent shared-account balances",()=>{
    expect(()=>aggregateAuthorizedFinancialPositions([
      snapshot(1,[{id:9,balance:"100"}]),snapshot(2,[{id:9,balance:"101"}])
    ])).toThrow(InvalidFinancialSnapshot);
  });
  it("rejects duplicate or mismatched site snapshots",()=>{
    expect(()=>aggregateAuthorizedFinancialPositions([snapshot(1,[]),snapshot(1,[])])).toThrow();
    const mismatched=snapshot(2,[]);
    mismatched.position.scopeSiteId=3;
    expect(()=>aggregateAuthorizedFinancialPositions([snapshot(1,[]),mismatched])).toThrow();
  });
  it("rejects corrupted or missing amounts and ledger integrity flags",()=>{
    const bad=snapshot(1,[]);
    bad.position.inventoryValue=null;
    expect(()=>aggregateAuthorizedFinancialPositions([bad,snapshot(2,[])])).toThrow();
    const negative=snapshot(1,[]);
    negative.position.inventoryValuationIssueCount=1;
    expect(()=>aggregateAuthorizedFinancialPositions([negative,snapshot(2,[])])).toThrow();
  });
  it("never accepts duplicate accounts inside the same site",()=>{
    expect(()=>aggregateAuthorizedFinancialPositions([
      snapshot(1,[{id:7,balance:"1"},{id:7,balance:"1"}]),snapshot(2,[])
    ])).toThrow();
  });
  it("rejects an invalid number of sites",()=>{
    expect(()=>aggregateAuthorizedFinancialPositions([snapshot(1,[])])).toThrow();
  });
});
