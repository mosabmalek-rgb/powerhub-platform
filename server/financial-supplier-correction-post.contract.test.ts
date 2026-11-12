import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const router=readFileSync("server/powerhub.ts","utf8");
const migration=readFileSync(
  "supabase/migrations/20261112193000_powerhub_financial_b416_supplier_source_correction.sql","utf8"
);
const regression=readFileSync(
  "docs/security/sql/pr359-financial-b416-supplier-atomic-correction-rollback.sql","utf8"
);
const start=router.indexOf("financialSupplierPaymentCorrectionRequest: protectedProcedure");
const end=router.indexOf("// B4.9: site-filtered transfer",start);
const code=router.slice(start,end);

describe("B4.16 supplier source correction server guard and rollback evidence",()=>{
  it("exposes two authenticated, tenant-scoped and separately permissioned operations",()=>{
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(code.match(/\.mutation\(async/g)).toHaveLength(2);
    expect(code.match(/"manageSupplierPayments"/g)).toHaveLength(2);
    expect(code.match(/"viewFinancialReports"/g)).toHaveLength(2);
    expect(code).toContain("p_tenant_id:access.tenantId");
    expect(code).toContain("p_user_id:ctx.user.id");
    expect(code).toContain("p_approver_id:ctx.user.id");
    expect(code).toContain("confirmIndependentReview:z.literal(true)");
    expect(code).toContain('result.accountingCertification!=="NOT_CERTIFIED"');
    expect(code).not.toContain("canReverseGLDirectly:true");
  });
  it("keeps corrections source-linked, atomic, and not certified",()=>{
    expect(migration).toContain("B416_MAKER_CANNOT_APPROVE_OWN_CORRECTION");
    expect(migration).toContain("powerhub_financial_supplier_payment_correction_proof");
    expect(migration).toContain("powerhub_financial_gl_post_source");
    expect(migration).toContain("SOURCE_BACKED_REVERSAL_VALID");
    expect(migration).toContain("FROM PUBLIC,anon,authenticated");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
  });
  it("stores repeatable maker/checker, payload conflict, isolation and GL-source rollback assertions",()=>{
    for(const marker of [
      "B416_CHANGED_OPERATION_ACCEPTED",
      "B416_SELF_APPROVAL_ACCEPTED",
      "B416_FOREIGN_TENANT_ACCEPTED",
      "B416_ORIGINAL_GL_FINGERPRINT_DRIFT",
      "B416_REPLAY_ADDED_DUPLICATES",
      "ROLLBACK;",
    ]) expect(regression).toContain(marker);
  });
});
