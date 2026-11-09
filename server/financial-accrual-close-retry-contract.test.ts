import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe,expect,it } from "vitest";
const source=(name:string)=>readFileSync(resolve(process.cwd(),name),"utf8");
const close=source("supabase/migrations/20261110000000_powerhub_financial_accrual_close_serialization.sql");
const journal=source("supabase/migrations/20261110001000_powerhub_financial_accrual_journal_serialization.sql");
const voidMigration=source("supabase/migrations/20261109240000_powerhub_financial_accrual_draft_void.sql");
const server=source("server/powerhub.ts");
const ui=source("client/src/components/finance/AccrualAccountingPanel.tsx");
describe("financial accrual close, reversal and retry protections",()=>{
 it("serializes period close before snapshot and each journal write",()=>{
  expect(close).toContain("'powerhub:accrual-period:'");
  expect(close).toContain("pg_advisory_xact_lock");
  expect(journal).toContain("'powerhub:accrual-period:'");
  for(const name of ["journal_create","journal_post","journal_reverse","journal_void"]){
   const index=journal.indexOf("CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_"+name+"(");
   expect(index).toBeGreaterThan(-1);
   const fragment=journal.slice(index,journal.indexOf("$"+name.split("_").at(-1)+"$;",index)+16);
   expect(fragment).toContain("pg_advisory_xact_lock");
  }
 });
 it("never silently loses unclassified fuel issuance costs at month end",()=>{
  expect(close).toContain("category='fuel' AND movement_type='issue'");
  expect(close).toContain("'unclassifiedInventoryIssueCount'");
  expect(close).toContain("ACCRUAL_SOURCES_NOT_RECONCILED");
 });
 it("does not quietly reuse a voided operation or a different reversal payload",()=>{
  expect(journal).toContain("ACCRUAL_OPERATION_ALREADY_VOID");
  expect(journal).toContain("reason=trim(p_reason) AND status<>'void'");
  expect(journal).toContain("ACCRUAL_REVERSAL_ALREADY_EXISTS");
  expect(voidMigration).toContain("ACCRUAL_POSTED_JOURNAL_REQUIRES_REVERSAL");
 });
 it("keeps RPC execution limited to the service role, and permission checks on the server",()=>{
  expect(journal).toContain("FROM PUBLIC,anon,authenticated");
  expect(journal).toContain("TO service_role");
  for(const name of ["accrualJournalVoid","accrualJournalPost","accrualJournalReverse"]){
   const i=server.indexOf(name+": protectedProcedure");
   expect(i).toBeGreaterThan(-1);
   expect(server.slice(i,i+700)).toContain("requireSupabaseSiteRole(");
  }
 });
 it("keeps ledger success messages and retry semantics aligned with actual saved status",()=>{
  expect(server).toContain(".from(\"financial_accrual_journals\").select(\"status\")");
  expect(server).toContain('actual.status as "draft"|"posted"');
  expect(ui).toContain('result.status==="posted"');
  expect(ui).toContain("القيد موجود ومعتمد بالفعل");
  expect(ui).toContain("accrual-reverse-${id}-${reversalPeriod}");
 });
 it("allows valid decimal cents without floating-point equality failure",()=>{
  expect(ui).toContain(String.raw`/^(?:0|[1-9]\\d*)(?:\\.\\d{1,2})?$/`.replace(/\\\\/g,"\\"));
  expect(ui).not.toContain("Math.round(value*100)!==value*100");
 });
});
