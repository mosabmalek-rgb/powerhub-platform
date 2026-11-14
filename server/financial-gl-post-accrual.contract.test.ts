import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe,expect,it} from "vitest";

const migration=readFileSync(resolve(process.cwd(),
  "supabase/migrations/20261110010000_powerhub_financial_gl_post_approved_accrual.sql"),"utf8");
const server=readFileSync(resolve(process.cwd(),"server/powerhub.ts"),"utf8");

describe("phase A2.1 atomic accrual to GL release boundary",()=>{
 it("posts from immutable approved accrual journal data, not client line amounts",()=>{
  expect(migration).toContain("FROM public.financial_accrual_journals j");
  expect(migration).toContain("v_source.status<>'posted'");
  expect(migration).toContain("v_source.approved_by_user_id=v_source.created_by_user_id");
  expect(migration).toContain("v_source.debit_account,'debit',v_source.amount");
  expect(migration).toContain("v_source.credit_account,'credit',v_source.amount");
  expect(migration).toContain("v_fingerprint:=encode(sha256(");
  expect(migration).toContain("'GL_SOURCE_REPLAY_MISMATCH'");
  expect(migration).toContain("'GL_REVERSAL_SOURCE_NOT_POSTED'");
 });
 it("preserves existing accrual period lock ordering",()=>{
  expect(migration).toContain("'powerhub:accrual-period:'");
  const lockAt=migration.indexOf("PERFORM pg_advisory_xact_lock");
  const sourceReadAt=migration.indexOf(
    "SELECT * INTO v_source FROM public.financial_accrual_journals j"
  );
  expect(lockAt).toBeGreaterThan(0);
  expect(sourceReadAt).toBeGreaterThan(lockAt);
  expect(migration.slice(sourceReadAt,sourceReadAt+230)).toContain("FOR SHARE");
 });
 it("narrows table grants and denies direct authenticated RPC access",()=>{
  for(const name of ["accounts","entries","lines"]){
   expect(migration).toContain(`REVOKE ALL ON TABLE public.financial_gl_${name} FROM service_role`);
   expect(migration).toContain(`GRANT SELECT, INSERT ON TABLE public.financial_gl_${name} TO service_role`);
  }
  for(const func of ["powerhub_financial_gl_post_accrual","powerhub_financial_accrual_post_and_gl"]){
   expect(migration).toContain(`public.${func}(`);
  }
  expect((migration.match(/FROM PUBLIC,anon,authenticated/g)||[]).length).toBeGreaterThanOrEqual(2);
  expect(migration).toContain("SECURITY INVOKER");
 });
 it("uses ONE server RPC under site scoped financial-management permission",()=>{
  const start=server.indexOf("accrualJournalPost:");
  const end=server.indexOf("accrualJournalVoid:",start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const block=server.slice(start,end);
  expect(block).toContain('requireSupabaseSiteRole(ctx.user.id,input.siteId,');
  expect(block).toContain('"manageExpenses"');
  expect(block).toContain('rpc("powerhub_financial_accrual_post_and_gl"');
  expect(block).not.toContain('rpc("powerhub_financial_accrual_journal_post"');
  expect(block).not.toContain('rpc("powerhub_financial_gl_post_accrual"');
 });
 it("does not alter interim profit-certification flags or source invoices",()=>{
  expect(migration).not.toContain("UPDATE public.invoices");
  expect(migration).not.toContain("isFinalProfit',true");
  expect(migration).not.toContain("isCompleteAccrualStatement',true");
 });
});
