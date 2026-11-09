import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe,expect,it} from "vitest";

const sql=readFileSync(resolve(process.cwd(),
 "supabase/migrations/20261110005000_powerhub_financial_gl_foundation.sql"),"utf8");
describe("phase A2 general-ledger schema foundation contract",()=>{
 it("is additive and does not bootstrap/activate source postings",()=>{
   for(const name of ["financial_gl_accounts","financial_gl_entries","financial_gl_lines"]){
     expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${name}`);
     expect(sql).toContain(`ALTER TABLE public.${name} ENABLE ROW LEVEL SECURITY`);
     expect(sql).toContain(`REVOKE ALL ON public.${name} FROM PUBLIC,anon,authenticated`);
     expect(sql).toContain(`GRANT SELECT ON public.${name} TO service_role`);
   }
   expect(sql).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\s+ON\s+public\.financial_gl_(?:accounts|entries|lines)\s+TO\s+service_role/i);
   expect(sql).not.toMatch(/INSERT\s+INTO\s+public\.financial_gl_/i);
   expect(sql).not.toContain("CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_post");
 });
 it("scopes account and entry sources to a tenant/site and blocks duplicate event posting",()=>{
   expect(sql).toContain("PRIMARY KEY (tenant_id,code)");
   expect(sql).toContain("CONSTRAINT financial_gl_entries_scope UNIQUE (id,tenant_id,site_id)");
   expect(sql).toContain("FOREIGN KEY (entry_id,tenant_id,site_id)");
   expect(sql).toContain("FOREIGN KEY (tenant_id,account_code)");
   expect(sql).toContain("financial_gl_entry_source_unique UNIQUE");
   expect(sql).toContain("(tenant_id,site_id,source_type,source_id,source_revision)");
   expect(sql).toContain("financial_gl_entry_operation_unique UNIQUE");
   expect(sql).toContain("financial_gl_active_reversal_unique");
   expect(sql).toContain("CONSTRAINT financial_gl_reversal_same_scope FOREIGN KEY");
   expect(sql).toContain("(reverses_entry_id,tenant_id,site_id)");
   expect(sql).toContain("FINANCIAL_GL_SITE_OUT_OF_SCOPE");
   expect(sql).toContain("s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id");
   expect(sql).toContain("financial_gl_entry_scope_guard");
   expect(sql).toContain("source_fingerprint ~ '^[0-9a-f]{64}$'");
 });
 it("requires double entry before commit and forbids changing posted rows",()=>{
   expect(sql).toContain("CREATE CONSTRAINT TRIGGER financial_gl_entry_balanced");
   expect(sql).toContain("CREATE CONSTRAINT TRIGGER financial_gl_line_balanced");
   expect((sql.match(/DEFERRABLE INITIALLY DEFERRED/g)||[]).length).toBe(2);
   expect(sql).toContain("v_count<2 OR v_total<>0");
   expect(sql).toContain("FINANCIAL_GL_ENTRY_NOT_BALANCED");
   expect(sql).toContain("FINANCIAL_GL_IMMUTABLE");
   for(const name of ["accounts","entries","lines"]){
     expect(sql).toContain(`BEFORE UPDATE OR DELETE OR TRUNCATE ON public.financial_gl_${name}`);
   }
 });
 it("keeps balance checks separate from financial report certification",()=>{
   expect(sql).toContain("No legacy source backfill or GL posting enabled");
   expect(sql).toContain("No client role may write");
   expect(sql).toContain("do not certify statements".replace("do not","Do not"));
 });
});
