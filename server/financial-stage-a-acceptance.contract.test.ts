import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const serviceRecognitionA37 = readFileSync(
  "docs/security/sql/pr359-financial-a37-service-recognition-rollback-smoke.sql", "utf8",
);
const payrollAdvanceA38 = readFileSync(
  "supabase/migrations/20261110141819_powerhub_payroll_disbursed_advance_integrity.sql", "utf8",
);
const payrollRegressionA38 = readFileSync(
  "docs/security/sql/pr359-financial-a38-advance-integrity-rollback.sql", "utf8",
);
const payrollPositiveA38 = readFileSync(
  "docs/security/sql/pr359-financial-a38-positive-disbursement-rollback.sql", "utf8",
);
const technicalFixtureA35 = readFileSync(
  "supabase/migrations/20261110133317_powerhub_financial_gl_prelaunch_technical_fixture_exclusion.sql", "utf8",
);
const technicalAcceptanceA35 = readFileSync(
  "docs/security/sql/pr359-financial-a35-technical-acceptance-readonly.sql", "utf8",
);
const sourceDateA32 = readFileSync(
  "docs/security/sql/pr359-financial-a32-opening-source-dates-readonly.sql", "utf8",
);
const closureA31 = readFileSync(
  "docs/security/sql/pr359-financial-a31-staging-closure-readonly.sql", "utf8",
);
const openingA29 = readFileSync(
  "docs/security/sql/pr359-financial-gl-a29-opening-custody-rollback.sql", "utf8",
);
const openingCustody = readFileSync(
  "supabase/migrations/20261110133500_powerhub_financial_gl_opening_document_custody.sql", "utf8",
);
const openingSetupUi = readFileSync(
  "client/src/components/finance/FinancialOpeningSetupPanel.tsx", "utf8",
);
const openingEvidenceUi = readFileSync(
  "client/src/components/finance/FinancialOpeningEvidenceWorkspace.tsx", "utf8",
);
const privateStorage = readFileSync("server/storage.ts", "utf8");
const openingEvidenceRuntime = readFileSync(
  "server/financial-opening-evidence.ts", "utf8",
);
const cashFlowAcceptance = readFileSync(
  "docs/security/sql/pr359-financial-gl-a26-cash-flow-rollback-acceptance.sql", "utf8",
);
const unifiedAcceptance = readFileSync(
  "docs/security/sql/pr359-financial-gl-a27-unified-acceptance-assertions.sql", "utf8",
);
const stagedManifestAcceptance = readFileSync(
  "docs/security/sql/pr359-financial-gl-a25-manifest-rollback-acceptance.sql", "utf8",
);
const installedSourceChain = readFileSync(
  "docs/security/sql/pr359-financial-gl-a24-rollback-source-chain.sql", "utf8",
);
const sourcePreflight = readFileSync(
  "docs/security/sql/pr359-financial-gl-backfill-source-preflight.sql", "utf8",
);
const provenance = readFileSync(
  "docs/security/sql/pr359-staging-performance-fixture-provenance-audit.sql", "utf8",
);
const acceptance = readFileSync(
  "docs/security/sql/pr359-financial-phase-a-final-readonly-acceptance.sql", "utf8",
);
const dashboard = readFileSync(
  "client/src/components/finance/FinancialGLAuditPanel.tsx", "utf8",
);
const quarantine = readFileSync(
  "supabase/migrations/20261110026000_powerhub_financial_staging_fixture_quarantine.sql", "utf8",
);
const auditedCashFlow = readFileSync(
  "supabase/migrations/20261110027000_powerhub_financial_cash_flow_fixture_guard.sql", "utf8",
);
const runtime = readFileSync("server/powerhub.ts", "utf8");
const financePage = readFileSync("client/src/pages/FinancialDashboardPage.tsx", "utf8");
const sources = readFileSync(
  "supabase/tests/financial_gl_operational_sources_integration.sql", "utf8",
);

describe("Phase A financial acceptance evidence", () => {
  it("requires source-dated opening evidence, not a zero-net performance fixture shortcut", () => {
    for(const marker of [
      "READ_ONLY_TEST_DATA_NOT_CERTIFIED",
      "STG-PERF-%",
      "Asia/Gaza",
      "accounts_created_after_opening",
      "synthetic_before_opening",
      "other_before_opening",
      "requiresIndependentOpeningReconciliation",
    ]) expect(sourceDateA32).toContain(marker);
    expect(sourceDateA32).not.toMatch(/\\b(?:INSERT|UPDATE|DELETE|TRUNCATE|COMMIT)\\b/i);
    expect(sourceDateA32).not.toContain("SECURITY DEFINER");
  });
  it("keeps opening custody uploads independent of URL signing", () => {
    expect(privateStorage).toContain("export async function storagePutPrivate(");
    expect(privateStorage).toContain("const uploaded = await storagePutPrivate(relKey, data, contentType);");
    const privateUpload = privateStorage.split("export async function storagePutPrivate(")[1]
      ?.split("export async function storagePut(")[0] ?? "";
    expect(privateUpload).toContain(".upload(");
    expect(privateUpload).not.toContain("storageGetSignedUrl(");
    expect(runtime).toContain("uploaded=await storagePutPrivate(fileKey,parsed.bytes,input.mimeType)");
  });
  it("recovers ambiguous evidence custody writes only with persisted byte hash proof", () => {
    for(const marker of [
      "recoveredAfterAmbiguousWrite:true",
      "recoveredAfterAmbiguousWrite:false",
      "openingDocumentDetails(",
      "openingDocumentHashMatches(",
      "committed.storage_key",
      "if(!recoveryError && committed",
    ]) expect(runtime).toContain(marker);
    expect(runtime).not.toContain("if(insertError) return {evidenceId");
  });

  it("reports remaining Staging acceptance blockers without altering data or fabricating approval", () => {
    for(const marker of [
      "READ_ONLY_NOT_CERTIFICATION",
      "qualifiedReviewers",
      "verifiedFixtureManifests",
      "postedOpenings",
      "postedGLEntries",
      "unreconciledSources",
      "openingEvidenceAudit",
      "sourceIntegrity",
      "FIXTURE_VERIFICATION_PENDING",
      "fixtureExclusionResolved",
      "fixtureTechnicalVerification",
      "OPENING_NOT_POSTED",
      "SOURCE_GL_INCOMPLETE",
      "OPENING_SUBLEDGER_RECONCILIATION_PENDING",
    ]) expect(closureA31).toContain(marker);
    expect(closureA31).not.toMatch(/\\b(?:INSERT|UPDATE|DELETE|TRUNCATE|COMMIT)\\b/i);
    expect(closureA31).not.toContain("SECURITY DEFINER");
  });

  it("retains executed A29 Staging custody and independent checker regression", () => {
    for(const phrase of [
      "BEGIN;", "ROLLBACK;", "powerhub_financial_gl_opening_create",
      "powerhub_financial_gl_opening_post", "powerhub_financial_gl_opening_evidence_submit",
      "powerhub_financial_gl_opening_evidence_review",
      "GL_OPENING_DOCUMENT_CUSTODY_REQUIRED",
      "GL_OPENING_DOCUMENT_CUSTODY_HASH_MISMATCH",
      "GL_OPENING_EVIDENCE_REVIEW_NOT_INDEPENDENT",
      "sourceSubledgersIndependentlyVerified",
      "A29_FALSE_ACCOUNTING_CERTIFICATION",
    ]) expect(openingA29).toContain(phrase);
    expect(openingA29).not.toContain("COMMIT;");
    expect(openingA29).not.toContain("DISABLE TRIGGER");
  });
  it("exposes scoped opening draft, independent post and void workflows without certification", () => {
    for(const route of [
      "financialGLChartInitialize",
      "financialGLChartAccounts",
      "financialGLOpeningEvidenceWorkspace",
      "financialGLChartInitialize",
      "financialGLOpeningCreate",
      "financialGLOpeningPost",
      "financialGLOpeningVoid",
      "createdByCurrentUser",
    ]) expect(runtime).toContain(route);
    for(const signal of [
      "financialGLOpeningCreate",
      "financialGLOpeningPost",
      "financialGLOpeningVoid",
      "createdByCurrentUser",
      "accountCode",
      "opening-ui-",
      "Math.abs(debit-credit)",
    ]) expect(openingSetupUi).toContain(signal);
    expect(openingEvidenceUi).toContain("FinancialOpeningSetupPanel");
    expect(openingEvidenceUi).toContain('opening?.status==="posted"');
    expect(openingSetupUi).not.toContain("CERTIFIED");
  });
  it("makes uploaded opening custody immutable, server byte-verified and independently reviewed", () => {
    for(const signal of [
      "financial_gl_opening_document_custody",
      "GL_OPENING_DOCUMENT_CUSTODY_HASH_MISMATCH",
      "GL_OPENING_DOCUMENT_CUSTODY_REQUIRED",
      "GL_OPENING_DOCUMENT_CUSTODY_IMMUTABLE",
      "zzz_gl_opening_document_custody_review_gate",
      "financial-opening-evidence/",
      "ENABLE ROW LEVEL SECURITY",
      "NOT_CERTIFIED",
    ]) {
      if(signal==="NOT_CERTIFIED") expect(runtime).toContain(signal);
      else expect(openingCustody).toContain(signal);
    }
    for(const signal of [
      "financialGLOpeningEvidenceUpload",
      "financialGLOpeningEvidenceReview",
      "financialGLOpeningEvidenceFileUrl",
      "financialGLOpeningEvidenceWorkspace",
      "parseOpeningDocumentBase64",
      "openingDocumentHashMatches",
      "openingDocumentDetails",
      "storagePut",
      ".download(",
      "requireSupabaseSiteRole",
      "accountingCertification:\"NOT_CERTIFIED\"",
    ]) expect(runtime).toContain(signal);
    expect(openingEvidenceRuntime).toContain('timingSafeEqual');
    expect(openingEvidenceUi).toContain("financialGLOpeningEvidenceUpload");
    expect(openingEvidenceUi).toContain("financialGLOpeningEvidenceReview");
    expect(openingEvidenceUi).toContain("reviewEvidenceId===ev.id");
    expect(dashboard).toContain("FinancialOpeningEvidenceWorkspace");
    expect(sources).toContain("20261110133500_powerhub_financial_gl_opening_document_custody.sql");
    expect(sources).toContain("GL_CI_A28_DOCUMENTLESS_APPROVAL");
    expect(sources).toContain("GL_CI_A28_CUSTODY_HASH_BYPASS");
    expect(openingCustody).not.toMatch(/\\bDELETE\\s+FROM\\s+public\\./i);
    expect(openingCustody).not.toContain("DISABLE TRIGGER");
    expect(openingCustody).not.toContain("CERTIFIED' AS");
  });

  it("validates exact full-month, partial-day, and clean-period cash flows under rollback", () => {
    for (const signal of [
      "BEGIN;",
      "ROLLBACK;",
      "A26_UNREVIEWED_CASH_FLOW_ALLOWED",
      "A26_REVIEW_REPLAY_FAILED",
      "A26_FULL_MONTH_FIXTURE_NOT_EXCLUDED",
      "A26_PARTIAL_DAY_EXCLUSION_DRIFT",
      "A26_NO_FIXTURE_MONTH_CHANGED",
      "powerhub_financial_period_cash_flow_raw",
      "powerhub_financial_period_cash_flow",
      "powerhub_financial_gl_verify_staging_fixture",
      "fixtureEvidenceSha256",
      "fixtureExcludedMovements",
      "NOT_CERTIFIED",
    ]) expect(cashFlowAcceptance).toContain(signal);
    expect(cashFlowAcceptance).not.toContain("COMMIT;");
    expect(cashFlowAcceptance).not.toContain("DISABLE TRIGGER");
    expect(cashFlowAcceptance).not.toMatch(/\\b(?:DELETE|TRUNCATE)\\s+(?:FROM\\s+)?public\\./i);
  });
  it("pins complete operational GL coverage while refusing fabricated opening certification", () => {
    for(const signal of [
      "A27_SOURCE_COVERAGE_OR_GL_INTEGRITY_DRIFT",
      "A27_FALSE_ACCOUNTING_CERTIFICATION",
      "unreconciledSourceCount",
      "isSourceCoverageComplete",
      "sourceIntegrity",
      "driftedEntries",
      "unauditedEntries",
      "quarantinedTestMovements",
      "isOpeningReconciled",
      "sourceSubledgersIndependentlyVerified",
      "INDEPENDENT_SUBLEDGER_RECONCILIATION_REQUIRED",
      "NOT_CERTIFIED",
      "trialDifference",
    ]) expect(unifiedAcceptance).toContain(signal);
    expect(unifiedAcceptance).not.toMatch(/\\b(?:INSERT|UPDATE|DELETE|TRUNCATE|COMMIT)\\b/i);
    expect(unifiedAcceptance).not.toContain("DISABLE TRIGGER");
  });
  it("keeps exact fixture maker-checker and 27-source evidence rollback-only", () => {
    for(const signal of [
      "BEGIN;",
      "ROLLBACK;",
      "A25_SELF_REVIEW_ACCEPTED",
      "A25_EXPIRED_REVIEWER_ACCEPTED",
      "powerhub_financial_gl_fixture_manifest_prepare",
      "powerhub_financial_gl_fixture_manifest_review",
      "powerhub_financial_gl_verify_staging_fixture",
      "quarantinedTestMovements",
      "unreconciledSourceCount",
      "NOT_CERTIFIED",
      "250000",
      "27",
    ]) expect(stagedManifestAcceptance).toContain(signal);
    expect(stagedManifestAcceptance).not.toContain("TRUNCATE");
    expect(stagedManifestAcceptance).not.toContain("COMMIT;");
    expect(stagedManifestAcceptance).not.toContain("DISABLE TRIGGER");
  });
  it("proves source posting and earned-service recognition on installed Staging with rollback", () => {
    for(const signal of [
      "BEGIN;",
      "ROLLBACK;",
      "A24_SOURCE_SITE_ALREADY_POSTED",
      "powerhub_financial_gl_opening_create",
      "powerhub_financial_gl_opening_post",
      "powerhub_financial_gl_post_source",
      "powerhub_financial_gl_recognize_billed_service",
      "A24_DUPLICATE_SOURCE_POST",
      "A24_SERVICE_REPLAY_INVALID",
      "A24_OUT_OF_CYCLE_RECOGNITION_ACCEPTED",
      "A24_INCOMPLETE_SERVICE_MONTH_ACCEPTED",
      "GL_SERVICE_MONTH_OUTSIDE_CYCLE",
      "GL_SERVICE_MONTH_NOT_COMPLETED",
      "A24_FALSE_ACCOUNTING_CERTIFICATION_OR_TRIAL_DRIFT",
      "STG-A24-TEST-NOT-CERTIFIED",
      "BALANCED_NOT_CERTIFIED",
    ]) expect(installedSourceChain).toContain(signal);
    expect(installedSourceChain).not.toMatch(/\\b(?:UPDATE|DELETE|TRUNCATE)\\s+(?:FROM\\s+)?public\\./i);
    expect(installedSourceChain).toContain("public.powerhub_financial_gl_trial_balance");
    expect(installedSourceChain).toContain("accountingCertification");
    expect(installedSourceChain).toContain("auth.users");
  });
  it("preflights GL sources by dependency without mutating historical entries", () => {
    for (const signal of [
      "BEGIN;",
      "ROLLBACK;",
      "pg_temp.powerhub_gl_preflight_probe",
      "powerhub_financial_gl_source_plan",
      "SOURCE_PLAN_VALID_NOT_POSTED",
      "WAITING_FOR_PREREQUISITE_GL",
      "INTERNAL_TRANSFER_NOT_DIRECT_GL",
      "STOCK_REQUIRES_SUPPLIER_COVERAGE_CHECK",
      "REQUIRES_SOURCE_REVIEW",
      "NO_PERSISTENT_CHANGES_ALL_STATEMENTS_ROLLED_BACK",
      "NOT_CERTIFIED",
    ]) expect(sourcePreflight).toContain(signal);
    expect(sourcePreflight).not.toMatch(/\\b(?:UPDATE|DELETE|TRUNCATE)\\s+(?:FROM\\s+)?public\\./i);
    expect(sourcePreflight).not.toContain("powerhub_financial_gl_post_source(");
    expect(sourcePreflight).not.toContain("powerhub_financial_gl_opening_create(");
    expect(sourcePreflight).not.toContain("powerhub_financial_gl_fixture_manifest_review(");
  });

  it("qualifies but never silently removes or relabels synthetic bank movements", () => {
    for (const evidence of [
      "d.count=250000",
      "d.unknown_reference=0",
      "d.unknown_description=0",
      "d.attributed_to_user=0",
      "d.non_fixture_type=0",
      "d.unexpected_amount=0",
      "d.linked_business_sources=0",
      "d.outside_fixture_dates=0",
      "x.other_table_references=0",
      "p.collections<>62500",
      "p.withdrawals<>62500",
      "p.signed_amount<>0",
      "BLOCKED_MANUAL_REVIEW_REQUIRED",
      "ARCHIVE_CANDIDATE_VERIFIED_NOT_ARCHIVED",
    ]) expect(provenance).toContain(evidence);
    expect(provenance).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(provenance).not.toMatch(/\bUPDATE\s+public\./i);
    expect(provenance).not.toMatch(/\bTRUNCATE\b/i);
    expect(provenance).not.toContain("DISABLE TRIGGER");
  });

  it("requires independent opening evidence, non-zero GL and complete sources", () => {
    for (const signal of [
      "gl_entries>0",
      "opening_reconciled IS TRUE",
      "matched_opening IS TRUE",
      "verified_subledgers IS TRUE",
      "source_clean IS TRUE",
      "unresolved=0",
      "performance_fixtures=0",
      "balance_difference=0",
      "phase_a_accounting_acceptance",
    ]) expect(acceptance).toContain(signal);
    expect(acceptance).toContain("BLOCKED");
    expect(acceptance).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(acceptance).not.toMatch(/\bUPDATE\s+public\./i);
  });

  it("quarantines only the exact dual-reviewed unchanged 250k Staging cohort", () => {
    for (const proof of [
      "NO_APPROVED_MANIFEST",
      "v_manifest.sha256",
      "extensions.digest(",
      "v_count<>250000",
      "v_good_accounts<>2",
      "v_external<>0",
      "GL_FIXTURE_SELF_REVIEW",
      "GL_FIXTURE_REVIEW_CONTENT_MISMATCH",
      "retainedRawRows",
      "quarantinedTestMovements",
      "financialCertification','NOT_CERTIFIED'",
      "powerhub_financial_gl_prior_operational_gaps_raw",
      "sourceSubledgersIndependentlyVerified",
    ]) {
      if (proof === "sourceSubledgersIndependentlyVerified") {
        expect(acceptance).toContain(proof);
      } else {
        expect(quarantine).toContain(proof);
      }
    }
    expect(sources).toContain(
      "20261110026000_powerhub_financial_staging_fixture_quarantine.sql",
    );
    expect(quarantine).not.toMatch(/DELETE\s+FROM\s+public\.account_transactions/i);
    expect(quarantine).not.toContain("DISABLE TRIGGER");
  });
  it("never renders balanced GL or synthetic archive eligibility as certification", () => {
    expect(dashboard).toContain("غير معتمدة محاسبيًا");
    expect(dashboard).toContain("isOpeningReconciled");
    expect(dashboard).toContain("sourceSubledgersIndependentlyVerified");
    expect(dashboard).toContain("performanceFixtureTagged");
  });
  it("requires independent signed-in actors for the Staging fixture workflow", () => {
    for (const contract of [
      "financialGLFixtureStatus",
      "financialGLFixturePrepare",
      "financialGLFixtureReview",
      "ctx.user.id",
      "acknowledgedIndependentReview:z.literal(true)",
      "powerhub_financial_gl_fixture_manifest_prepare",
      "powerhub_financial_gl_fixture_manifest_review",
      "GL_FIXTURE_SELF_REVIEW",
    ]) expect(runtime).toContain(contract);
    expect(runtime).toContain("https://iyuryuhaylhisjfcrwkz.supabase.co");
    expect(runtime).toContain("financialCertification");
    expect(dashboard).toContain("financialGLFixtureStatus");
    expect(dashboard).toContain("financialGLFixturePrepare");
    expect(dashboard).toContain("financialGLFixtureReview");
    expect(dashboard).toContain("preparerIsCurrentUser");
    expect(dashboard).toContain("مراجع آخر");
    expect(dashboard).toContain("لا تزال القوائم المالية غير معتمدة");
  });
  it("never presents a Staging performance fixture as operational cash flow without dual review", () => {
    for (const signal of [
      "GL_CASHFLOW_FIXTURE_REVIEW_REQUIRED",
      "powerhub_financial_gl_verify_staging_fixture",
      "GL_CASHFLOW_FIXTURE_SUBTRACTION_INVALID",
      "GL_CASHFLOW_RAW_TOTALS_INVALID",
      "powerhub_financial_period_cash_flow_raw",
      "v_has_fixture",
      "v_fixture_in",
      "v_fixture_out",
      "v_fixture_count",
      "EXACT_REVIEWED_COHORT_EXCLUDED",
      "NO_FIXTURE_IN_SCOPED_PERIOD",
      "NOT_CERTIFIED",
      "p_period_start >= p_period_end_exclusive",
    ]) expect(auditedCashFlow).toContain(signal);
    expect(auditedCashFlow).not.toMatch(/\\bDELETE\\s+FROM\\b/i);
    expect(auditedCashFlow).not.toMatch(/\\bTRUNCATE\\b/i);
    expect(auditedCashFlow).not.toContain("DISABLE TRIGGER");
    expect(auditedCashFlow).toContain("REVOKE ALL ON FUNCTION public.powerhub_financial_period_cash_flow(");
    expect(auditedCashFlow).toContain("REVOKE ALL ON FUNCTION public.powerhub_financial_period_cash_flow_raw(");
  });

  it("surfaces fixture restrictions to the browser without partial or false cash-flow success", () => {
    expect(runtime).toContain("GL_CASHFLOW_FIXTURE_REVIEW_REQUIRED");
    expect(runtime).toContain("تحتوي الفترة على حركات أداء تجريبية");
    expect(runtime).toContain("fixtureExcludedMovements:excluded");
    expect(runtime).toContain("EXACT_REVIEWED_COHORT_EXCLUDED");
    expect(runtime).toContain("تقرير الاتجاه النقدي يفتقر إلى إثبات تصنيف حركات الأداء");
    expect(financePage).toContain("cashFlow.data.fixtureExcludedMovements");
    expect(financePage).toContain("موافقة مراجعة مستقلة");
    expect(financePage).toContain("ليس شهادة محاسبية نهائية");
  });

  it("distinguishes A35 technical prelaunch quarantine from human certification", () => {
    expect(technicalFixtureA35).toContain("STAGING_PRELAUNCH_TECHNICAL");
    expect(technicalFixtureA35).toContain("'humanReviewed'");
    expect(technicalFixtureA35).toContain("'NOT_CERTIFIED'");
    expect(technicalFixtureA35).toContain("powerhub_financial_gl_verify_staging_fixture");
    expect(technicalFixtureA35).toContain("GL_STAGING_TECHNICAL_FULL_SHA_OR_BALANCE_INVALID");
    expect(technicalFixtureA35).not.toMatch(/\\bDELETE\\s+FROM\\s+public[.]account_transactions\\b/i);
    expect(technicalAcceptanceA35).toContain("remainingOperationalGaps");
    expect(runtime).toContain('verificationMode:"technical"');
    expect(runtime).toContain('proof.humanReviewed===false');
    expect(dashboard).toContain('fixture.data.verificationMode === "technical"');
  });

  it("requires A37 full source reconciliation and October-only earned service on rollback", () => {
    expect(serviceRecognitionA37).toContain("A37_SERVICE_RECOGNITION_REPLAY_NOT_IDEMPOTENT");
    expect(serviceRecognitionA37).toContain("powerhub_financial_gl_recognize_billed_service");
    expect(serviceRecognitionA37).toContain("'2026-10'");
    expect(serviceRecognitionA37).toContain("'octoberServiceRecognitions',3");
    expect(serviceRecognitionA37).toContain("unreconciledSourceCount')::bigint<>0");
    expect(serviceRecognitionA37).toContain("ROLLBACK;");
    expect(serviceRecognitionA37).toContain("'NOT_CERTIFIED'");
    expect(serviceRecognitionA37).not.toMatch(/\\bCOMMIT\\s*;/i);
  });

  it("rejects unsupported payroll salary-advance deductions at draft, approval and GL", () => {
    expect(payrollAdvanceA38).toContain("powerhub_payroll_advance_allocations_valid");
    expect(payrollAdvanceA38).toContain("PAYROLL_ADVANCE_DISBURSEMENT_OR_ALLOCATION_INVALID");
    expect(payrollAdvanceA38).toContain("GL_PAYROLL_ADVANCE_DISBURSEMENT_OR_ALLOCATION_INVALID");
    expect(payrollAdvanceA38).toContain("tx.amount=adj.amount");
    expect(payrollAdvanceA38).toContain("tx.transaction_type='withdrawal'");
    expect(payrollRegressionA38).toContain("PASS_ROLLBACK_ONLY");
    expect(runtime).toContain('errorText.includes("PAYROLL_ADVANCE_DISBURSEMENT_OR_ALLOCATION_INVALID")');
    expect(runtime).toContain('GL_PAYROLL_ADVANCE_DISBURSEMENT_OR_ALLOCATION_INVALID');
    expect(runtime).toContain('لا يمكن ترحيل الرواتب: خصم السلفة غير مدعوم');
    expect(payrollRegressionA38).toContain("ROLLBACK;");
    expect(payrollRegressionA38).not.toMatch(/\\bCOMMIT\\s*;/i);
    expect(serviceRecognitionA37).not.toContain('"accountCode":"1700","side":"debit","amount":100');
    expect(serviceRecognitionA37).toContain('"accountCode":"1010","side":"debit","amount":0.01');
  });

  it("accepts an advance only when a matched withdrawal is evidenced before payroll", () => {
    expect(payrollPositiveA38).toContain("disbursement_transaction_id=v_tx");
    expect(payrollPositiveA38).toContain("A38_VALID_DISBURSEMENT_FALSELY_REJECTED");
    expect(payrollPositiveA38).toContain("powerhub_financial_gl_source_plan");
    expect(payrollPositiveA38).toContain("'PASS_ROLLBACK_ONLY'");
    expect(payrollPositiveA38).toContain("ROLLBACK;");
    expect(payrollPositiveA38).not.toMatch(/\\bCOMMIT\\s*;/i);
  });

});
