import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe,expect,it } from "vitest";
const source=(path:string)=>readFileSync(resolve(process.cwd(),path),"utf8");
const accrual=source("supabase/migrations/20261109180000_powerhub_financial_accrual_month_review.sql");
const journal=source("supabase/migrations/20261109190000_powerhub_financial_accrual_adjustment_journal.sql");
const statement=source("supabase/migrations/20261109200000_powerhub_financial_accrual_statement.sql");
const server=source("server/powerhub.ts");
const panel=source("client/src/components/finance/AccrualAccountingPanel.tsx");
describe("financial accrual first phase immutable ledger contract",()=>{
 it("recognizes service by service-cycle completion, not collection or issue date",()=>{
   expect(accrual).toContain("cycle_end_at<=p_as_of");
   expect(accrual).toContain("AT TIME ZONE 'Asia/Gaza'");
   expect(accrual).toContain("serviceBillingExTax");
   expect(accrual).toContain("missingCycleCount");
   expect(accrual).toContain("'isFinalProfit',false");
 });
 it("separates approved gross wages from cash payout and stock consumption from purchases",()=>{
   expect(accrual).toContain("SUM(total_gross) FILTER (WHERE status IN ('approved','paid'))");
   expect(accrual).toContain("category<>'payroll'");
   expect(accrual).toContain("m.movement_type IN ('issue','fuel_consumption','return_from_issue')");
   expect(accrual).toContain("purchaseGrossNotExpensed");
   expect(accrual).toContain("reversal_of_movement_id");
   expect(accrual).toContain("source_issue_movement_id");
 });
 it("uses balanced debit-credit adjustments with immutable approvals",()=>{
   expect(journal).toContain("debit_account text NOT NULL");
   expect(journal).toContain("credit_account text NOT NULL");
   expect(journal).toContain("ACCRUAL_SEPARATION_OF_DUTIES");
   expect(journal).toContain("ACCRUAL_JOURNAL_IMMUTABLE");
   expect(journal).toContain("ACCRUAL_OPERATION_KEY_CONFLICT");
   expect(journal).toContain("reverses_journal_id bigint UNIQUE");
   expect(journal).toContain("ENABLE ROW LEVEL SECURITY");
   expect(journal).toContain("FROM PUBLIC,anon,authenticated");
 });
 it("includes only posted journals in provisional P&L and never claims final profit",()=>{
   expect(statement).toContain("period=p_period AND status='posted'");
   expect(statement).toContain("debit_account='4100'");
   expect(statement).toContain("credit_account='4100'");
   expect(statement).toContain("'balancedDebits'");
   expect(statement).toContain("'balancedCredits'");
   expect(statement).toContain("'provisionalNetAfterAdjustments'");
   expect(statement).toContain("'isFinalProfit',false");
   expect(statement).toContain("'isCompleteAccrualStatement',false");
 });
 it("requires server authorization on every reader and writer, and on-demand UI",()=>{
   for(const method of ["accrualMonthStatement:","accrualJournalList:","accrualJournalCreate:",
     "accrualJournalPost:","accrualJournalReverse:"]){
     const start=server.indexOf(method);
     expect(start).toBeGreaterThan(0);
     expect(server.slice(start,start+1500)).toContain("requireSupabaseSiteRole(");
   }
   expect(panel).toContain("enabled:active");
   expect(panel).toContain("createdByUserId");
   expect(panel).toContain("reason.trim().length<10");
   expect(panel).toContain("crypto.randomUUID()");
 });
});
