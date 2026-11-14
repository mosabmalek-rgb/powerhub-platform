import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe,it,expect} from "vitest";

const read=(name:string)=>readFileSync(resolve(process.cwd(),name),"utf8");
const truncation=read("supabase/migrations/20261110002000_powerhub_financial_accrual_truncate_guard.sql");
const detail=read("supabase/migrations/20261110003000_powerhub_financial_accrual_source_detail_fingerprint.sql");
const server=read("server/powerhub.ts");
const ui=read("client/src/components/finance/AccrualAccountingPanel.tsx");

describe("financial accrual acceptance security and provenance",()=>{
  it("protects both audit tables against TRUNCATE and removes DELETE/TRUNCATE service privileges",()=>{
    for(const table of ["financial_accrual_journals","financial_accrual_period_reviews"]){
      expect(truncation).toContain("BEFORE TRUNCATE ON public."+table);
      expect(truncation).toContain("REVOKE ALL ON public."+table+" FROM service_role");
      expect(truncation).toContain("GRANT SELECT,INSERT,UPDATE ON public."+table+" TO service_role");
    }
    expect(truncation).toContain("ACCRUAL_AUDIT_TABLE_TRUNCATE_DENIED");
  });
  it("uses a deterministic, tenant/site-scoped digest of source details as well as month totals",()=>{
    for(const source of ["invoices","billing_adjustments","expenses","payroll_runs",
      "inventory_stock_movements","inventory_items","supplier_purchases",
      "account_transactions","financial_settlements","financial_accrual_journals"]){
      expect(detail).toContain("public."+source);
    }
    expect(detail).toContain("ORDER BY source_type,source_id");
    expect(detail).toContain("md5(to_jsonb(");
    expect(detail).toContain("source_fingerprint");
    expect(detail).toContain("public.powerhub_financial_accrual_detail_fingerprint(p_tenant_id,p_site_id,p_period)");
    expect(detail).toContain("FROM PUBLIC,anon,authenticated");
    expect(detail).toContain("TO service_role");
  });
  it("does not promote a preliminary report into a certified profit statement",()=>{
    expect(server).toContain("isFinalProfit:false as const");
    expect(server).toContain("isCompleteAccrualStatement:false as const");
    expect(ui).toContain("رصيد أولي غير معتمد كصافي ربح");
  });
});
