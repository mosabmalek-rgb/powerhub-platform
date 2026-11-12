import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const router=readFileSync("server/powerhub.ts","utf8");
const migration=readFileSync(
  "supabase/migrations/20261112191500_powerhub_financial_b415_supplier_payment_correction_preflight.sql","utf8"
);
const routeStart=router.indexOf("financialSupplierPaymentCorrectionReadiness: protectedProcedure");
const routeEnd=router.indexOf("// B4.9: site-filtered transfer",routeStart);
const route=router.slice(routeStart,routeEnd);

describe("B4.15 supplier payment correction evidence, read-only and fail closed",()=>{
  it("requires both financial report and supplier payment capability for the authenticated tenant/site",()=>{
    expect(routeStart).toBeGreaterThan(0);
    expect(routeEnd).toBeGreaterThan(routeStart);
    expect(route).toContain('"viewFinancialReports"');
    expect(route).toContain('"manageSupplierPayments"');
    expect(route).toContain('p_tenant_id:access.tenantId');
    expect(route).toContain('p_site_id:input.siteId');
    expect(route).toContain('p_payment_id:input.paymentId');
    expect(route).toContain('.query(async');
    expect(route).not.toContain('.mutation(async');
  });
  it("rejects mismatched scope or any fabricated approval/certification",()=>{
    expect(route).toContain('result.tenantId!==access.tenantId');
    expect(route).toContain('result.siteId!==input.siteId');
    expect(route).toContain('result.paymentId!==input.paymentId');
    expect(route).toContain('result.accountingCertification!=="NOT_CERTIFIED"');
    expect(route).toContain('result.canPostCorrection!==false');
    expect(route).toContain('result.canReverseGLDirectly!==false');
    expect(route).toContain('result.correctionWorkflowImplemented!==false');
    expect(route).toContain('result.makerCheckerRequired!==true');
  });
  it("never inserts a fabricated correcting journal, cash movement or supplier reversal",()=>{
    expect(migration).toContain("SOURCE_VERIFIED_WORKFLOW_NOT_IMPLEMENTED");
    expect(migration).toContain("sourceEvidenceVerified");
    expect(migration).toContain("sourceFingerprint");
    expect(migration).toContain("canPostCorrection',false");
    expect(migration).toContain("correctionWorkflowImplemented',false");
    expect(migration).toContain("accountingCertification','NOT_CERTIFIED");
    expect(migration).not.toMatch(/\bINSERT\s+INTO\s+public\.(?:financial_gl_entries|financial_gl_lines|account_transactions|supplier_ledger_entries|supplier_payments)\b/i);
    expect(migration).not.toMatch(/\bUPDATE\s+public\.(?:financial_gl_entries|financial_gl_lines|account_transactions|supplier_ledger_entries|supplier_payments)\b/i);
    expect(migration).toContain("FROM PUBLIC,anon,authenticated");
    expect(migration).toContain("TO service_role");
  });
});
