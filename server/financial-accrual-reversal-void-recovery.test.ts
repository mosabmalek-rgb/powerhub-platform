import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe,it,expect} from "vitest";
const get=(p:string)=>readFileSync(resolve(process.cwd(),p),"utf8");
const patch=get("supabase/migrations/20261110004000_powerhub_financial_accrual_reversal_void_recovery.sql");
const api=get("server/powerhub.ts");
const ui=get("client/src/components/finance/AccrualAccountingPanel.tsx");
describe("voided reversal draft recovery",()=>{
 it("retains voided reversal history but permits one active reversal",()=>{
  expect(patch).toContain("DROP CONSTRAINT IF EXISTS financial_accrual_journals_reverses_journal_id_key");
  expect(patch).toContain("CREATE UNIQUE INDEX IF NOT EXISTS financial_accrual_active_reversal_unique");
  expect(patch).toContain("WHERE reverses_journal_id IS NOT NULL AND status<>'void'");
  expect(patch).toContain("WHERE reverses_journal_id=p_journal_id AND status<>'void'");
  expect(patch).toContain("ACCRUAL_REVERSAL_ALREADY_EXISTS");
 });
 it("shows only active reversals as blockers and still lists canceled drafts in their own period",()=>{
  expect(api).toContain('.neq("status","void").limit(201)');
  expect(api).toContain("voidReason:");
  expect(ui).toContain("item.reversal");
  expect(ui).toContain('item.status==="void"');
 });
 it("creates a new key per new attempt, preserving it on network retry",()=>{
  expect(ui).toContain("const [reversalOperationKey,setReversalOperationKey]=useState<string|null>(null)");
  expect(ui).toContain("setReversalOperationKey(operationKey)");
  expect(ui).toContain("accrual-reverse-${id}-${crypto.randomUUID()}");
  expect(ui).toContain("setReversalOperationKey(null)");
  expect(ui).toContain("canLockReview");
  expect(ui).toContain("closeBlockers");
  expect(ui).toContain("unreconciledPayrollPayoutCount");
  expect(ui).toContain("unclassifiedInventoryIssueCount");
 });
});
