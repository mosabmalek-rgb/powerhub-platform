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
const engineeringAcceptanceA39 = readFileSync(
  "docs/security/sql/pr359-financial-a39-engineering-acceptance-rollback.sql", "utf8",
);
const payrollAdvanceCashDateA40 = readFileSync(
  "docs/security/sql/pr359-financial-a40-advance-cash-date-rollback.sql", "utf8",
);
const payrollAdvanceGuardA40 = readFileSync(
  "supabase/migrations/20261110145822_powerhub_payroll_advance_cash_date_crosscheck.sql", "utf8",
);
const glActorGuardA41 = readFileSync(
  "supabase/migrations/20261110152142_powerhub_financial_gl_actor_membership_guards.sql","utf8",
);
const glActorScopeA41 = readFileSync(
  "docs/security/sql/pr359-financial-a41-actor-scope-rollback.sql","utf8",
);
const zeroOpeningMigrationA42 = readFileSync(
  "supabase/migrations/20261110154921_powerhub_financial_gl_zero_opening_no_fictitious_cents.sql","utf8",
);
const zeroOpeningAcceptanceA42 = readFileSync(
  "docs/security/sql/pr359-financial-a42-zero-opening-full-rollback.sql","utf8",
);
const fixtureFastPreflightA43 = readFileSync(
  "supabase/migrations/20261110160749_powerhub_financial_gl_verified_fixture_fast_zero_preflight.sql", "utf8",
);
const fixtureFastAcceptanceA43 = readFileSync(
  "docs/security/sql/pr359-financial-a43-verified-fixture-fast-preflight-rollback.sql", "utf8",
);
const technicalBootstrapMigrationA44 = readFileSync(
  "supabase/migrations/20261110165044_powerhub_financial_gl_prelaunch_technical_bootstrap.sql","utf8",
);
const technicalBootstrapRollbackA44 = readFileSync(
  "docs/security/sql/pr359-financial-a44-prelaunch-bootstrap-rollback.sql","utf8",
);
const prelaunchAcceptanceA45 = readFileSync("supabase/migrations/20261110170636_powerhub_financial_gl_prelaunch_engineering_acceptance_status.sql", "utf8");
const durableAcceptanceCheckA45 = readFileSync("docs/security/sql/pr359-financial-a45-durable-acceptance-readonly.sql", "utf8");
const glAuditUiA45 = readFileSync("client/src/components/finance/FinancialGLAuditPanel.tsx", "utf8");
const bootstrapExpiryMigrationA46 = readFileSync("supabase/migrations/20261110172614_powerhub_financial_gl_prelaunch_authorization_expiry_visibility.sql","utf8");
const bootstrapExpiryAcceptanceA46 = readFileSync("docs/security/sql/pr359-financial-a46-bootstrap-expiry-readonly.sql","utf8");
const phaseA47FinalEngineering = readFileSync("docs/security/sql/pr359-financial-a47-engineering-closeout.sql", "utf8");
const phaseA47AcceptanceReport = readFileSync("docs/roadmaps/powerhub-finance-phase-a-engineering-acceptance-20261110.md", "utf8");
const financialStatementsB1Sql = readFileSync("supabase/migrations/20261110180332_powerhub_financial_gl_site_statements_b1.sql", "utf8");
const financialStatementsB1Acceptance = readFileSync("docs/security/sql/pr359-financial-b1-gl-statements-rollback.sql", "utf8");
const financialStatementsB1Ui = readFileSync("client/src/components/finance/FinancialGLAuditPanel.tsx", "utf8");
const phaseB2CentralPolicySql = readFileSync("supabase/migrations/20261110182702_powerhub_financial_gl_central_policy_management_b2.sql","utf8");
const phaseB2CentralPolicyAcceptance = readFileSync("docs/security/sql/pr359-financial-b2-central-allocation-rollback.sql","utf8");
const b3TenantRollupSql = readFileSync("supabase/migrations/20261110201500_powerhub_financial_gl_tenant_preliminary_rollup_b3.sql","utf8");
const companyMovementB42Sql = readFileSync(
  "supabase/migrations/20261110213320_powerhub_financial_gl_b4_company_movement_provenance.sql","utf8",
);
const companyMovementB42Acceptance = readFileSync(
  "docs/security/sql/pr359-financial-b4-company-movement-rollback.sql","utf8",
);
const b4DocumentSourceSql = readFileSync(
  "supabase/migrations/20261110211645_powerhub_financial_gl_b4_document_source_audit.sql", "utf8",
);
const b4DocumentSourceRegression = readFileSync(
  "docs/security/sql/pr359-financial-b4-document-source-audit-rollback.sql", "utf8",
);
const b3TenantRollupCheck = readFileSync("docs/security/sql/pr359-financial-b3-preliminary-rollup-rollback.sql","utf8");
const financialCentralB2Ui = readFileSync("client/src/components/finance/FinancialCentralAllocationWorkspace.tsx","utf8");
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

  it("keeps engineering rollback acceptance separate from financial certification", () => {
    expect(engineeringAcceptanceA39).toContain("ENGINEERING_PASS_ROLLBACK_ONLY");
    expect(engineeringAcceptanceA39).toContain("A39_FALSE_FINANCIAL_CERTIFICATION");
    expect(engineeringAcceptanceA39).toContain("A39_DETERMINISTIC_SUBLEDGER_ACCOUNT_MISMATCH");
    expect(engineeringAcceptanceA39).toContain("powerhub_financial_gl_source_integrity");
    expect(engineeringAcceptanceA39).toContain("sourceSubledgersIndependentlyVerified");
    expect(engineeringAcceptanceA39).toContain("'financialCertification','NOT_CERTIFIED'");
    expect(engineeringAcceptanceA39).toContain("'humanApproved',false");
    expect(engineeringAcceptanceA39).toContain("ROLLBACK;");
    expect(engineeringAcceptanceA39).not.toMatch(/\\bCOMMIT\\s*;/i);
  });

  it("enforces real cash chronology for payroll advance deduction and blocks backdating", () => {
    expect(payrollAdvanceGuardA40).toContain("tx.occurred_at AT TIME ZONE 'Asia/Gaza'");
    expect(payrollAdvanceGuardA40).toContain("adj.disbursed_at AT TIME ZONE 'Asia/Gaza'");
    expect(payrollAdvanceGuardA40).toContain("tx.related_expense_id IS NULL");
    expect(payrollAdvanceCashDateA40).toContain("A40_LATE_CASH_POSTING_BACKDATED_AS_ADVANCE_ACCEPTED");
    expect(payrollAdvanceCashDateA40).toContain("A40_FUTURE_DISBURSEMENT_ACCEPTED");
    expect(payrollAdvanceCashDateA40).toContain("A40_VALID_CASH_DISBURSEMENT_REJECTED");
    expect(payrollAdvanceCashDateA40).toContain("PASS_ROLLBACK_ONLY");
    expect(payrollAdvanceCashDateA40).toContain("ROLLBACK;");
    expect(payrollAdvanceCashDateA40).not.toMatch(/\\bCOMMIT\\s*;/i);
  });

  it("rejects outsider and expired actor IDs at all five financial GL RPC boundaries", () => {
    expect(glActorGuardA41).toContain("powerhub_financial_gl_authorized_actor");
    expect(glActorGuardA41).toContain("GL_OPENING_ACTOR_FORBIDDEN");
    expect(glActorGuardA41).toContain("GL_OPENING_APPROVER_FORBIDDEN");
    expect(glActorGuardA41).toContain("GL_OPENING_VOID_ACTOR_FORBIDDEN");
    expect(glActorGuardA41).toContain("GL_SOURCE_ACTOR_FORBIDDEN");
    expect(glActorGuardA41).toContain("GL_SERVICE_ACTOR_FORBIDDEN");
    expect(glActorGuardA41).toContain("m.membership_status='active'");
    expect(glActorGuardA41).toContain("m.expires_at>statement_timestamp()");
    expect(glActorScopeA41).toContain("A41_REVOKED_POST_ACCEPTED");
    expect(glActorScopeA41).toContain("A41_EXPIRED_ACCEPTED");
    expect(glActorScopeA41).toContain("A41_REPLAY_BYPASS_ACCEPTED");
    expect(glActorScopeA41).toContain("PASS_ROLLBACK_ONLY");
    expect(glActorScopeA41).toContain("ROLLBACK;");
    expect(glActorScopeA41).not.toMatch(/\\bCOMMIT\\s*;/i);
  });

  it("accepts source-backed zero opening without invented 0.01 and never certifies it", () => {
    expect(zeroOpeningMigrationA42).toContain("powerhub_financial_gl_zero_opening_preflight");
    expect(zeroOpeningMigrationA42).toContain("ZERO_OPENING_TECHNICAL_NOT_CERTIFIED");
    expect(zeroOpeningMigrationA42).toContain("documented-zero-opening-v1");
    expect(zeroOpeningMigrationA42).toContain("expected_line_count=0");
    expect(zeroOpeningMigrationA42).toContain("v_count=0");
    expect(zeroOpeningAcceptanceA42).toContain("'[]'::jsonb");
    expect(zeroOpeningAcceptanceA42).toContain("'openingIsZero',true");
    expect(zeroOpeningAcceptanceA42).toContain("A42_FALSE_FINANCIAL_CERTIFICATION");
    expect(zeroOpeningAcceptanceA42).toContain("'financialCertification','NOT_CERTIFIED'");
    expect(zeroOpeningAcceptanceA42).toContain("ROLLBACK;");
    expect(zeroOpeningAcceptanceA42).not.toMatch(/\\bCOMMIT\\s*;/i);
    expect(runtime).toContain("input.lines.length === 0");
    expect(runtime).toContain('input.evidenceReference.startsWith("ZERO-OPENING:")');
  });

  it("keeps A43 zero-opening preflight fast without weakening synthetic SHA custody", () => {
    expect(fixtureFastPreflightA43).toContain("A43_STAGING_FIXTURE_SHA_MISMATCH");
    expect(fixtureFastPreflightA43).toContain("GL_VERIFIED_FIXTURE_COHORT_IMMUTABLE");
    expect(fixtureFastPreflightA43).toContain("BEFORE TRUNCATE");
    expect(fixtureFastPreflightA43).toContain("account_transactions_nonfixture_opening_idx");
    expect(fixtureFastPreflightA43).toContain("financial_gl_staging_technical_exclusions");
    expect(fixtureFastAcceptanceA43).toContain("A43_NONFIXTURE_PRIOR_ACTIVITY_IGNORED");
    expect(fixtureFastAcceptanceA43).toContain("A43_NEW_FIXTURE_INSERT_ALLOWED");
    expect(fixtureFastAcceptanceA43).toContain("PASS_ROLLBACK_ONLY");
    expect(fixtureFastAcceptanceA43).toContain("ROLLBACK;");
    expect(fixtureFastAcceptanceA43).not.toMatch(/\\bCOMMIT\\s*;/i);
  });

  it("requires tightly scoped prelaunch source projection without claimed certification", () => {
    expect(technicalBootstrapMigrationA44).toContain("A44");
    expect(technicalBootstrapMigrationA44).toContain("powerhub_financial_gl_prelaunch_tech_valid");
    expect(technicalBootstrapMigrationA44).toContain("GL_PRELAUNCH_TECHNICAL_BOOTSTRAP_IMMUTABLE");
    expect(technicalBootstrapMigrationA44).toContain("NOT_CERTIFIED");
    expect(technicalBootstrapMigrationA44).toContain("ENABLE ROW LEVEL SECURITY");
    expect(technicalBootstrapRollbackA44).toContain("A44_BOOTSTRAP_SCOPE_BYPASS");
    expect(technicalBootstrapRollbackA44).toContain("A44_ENGINEERING_NOT_CLEAN");
    expect(technicalBootstrapRollbackA44).toContain("ROLLBACK;");
    expect(technicalBootstrapRollbackA44).not.toMatch(/\\bCOMMIT\\s*;/i);
  });

  it("shows durable engineering acceptance without ever certifying accounts", () => {
    expect(prelaunchAcceptanceA45).toContain("PASS_PRELAUNCH_ENGINEERING_ONLY");
    expect(prelaunchAcceptanceA45).toContain("STAGING_PRELAUNCH_GL_TECHNICAL_POSTING_A44");
    expect(prelaunchAcceptanceA45).toContain("'NOT_CERTIFIED'");
    expect(prelaunchAcceptanceA45).toContain("'isFinalFinancialAcceptance',false");
    expect(durableAcceptanceCheckA45).toContain("A45_ACCEPTANCE_FAILED_CLOSED");
    expect(durableAcceptanceCheckA45).toContain("'2026-11'");
    expect(durableAcceptanceCheckA45).not.toMatch(/\\bCOMMIT\\s*;/i);
    expect(glAuditUiA45).toContain("القبول الهندسي لبيانات ما قبل الإطلاق");
    expect(glAuditUiA45).toContain("وليس افتتاحية معتمدة");
    expect(glAuditUiA45).toContain("isFinalFinancialAcceptance === false");
  });

  it("separates historical prelaunch engineering success from expiring posting authority", () => {
    expect(bootstrapExpiryMigrationA46).toContain("technicalBootstrapActive");
    expect(bootstrapExpiryMigrationA46).toContain("technicalBootstrapExpiresAt");
    expect(bootstrapExpiryMigrationA46).toContain("newPostingRequiresDocumentaryOpening");
    expect(bootstrapExpiryMigrationA46).toContain("powerhub_financial_gl_prelaunch_tech_valid");
    expect(bootstrapExpiryAcceptanceA46).toContain("A46_EXPIRY_OR_CERTIFICATION_CONTRACT_FAILED");
    expect(bootstrapExpiryAcceptanceA46).not.toMatch(/\\bCOMMIT\\s*;/i);
    expect(glAuditUiA45).toContain("صلاحية الترحيل التقني الجديد");
    expect(glAuditUiA45).toContain("يلزم اعتماد افتتاحية موثقة");
  });

  it("retains stage-A final engineering evidence and blocks false certification", () => {
    expect(phaseA47FinalEngineering).toContain("PASS_STAGING_ENGINEERING_ONLY");
    expect(phaseA47FinalEngineering).toContain("A47_UNBALANCED_OR_INCOMPLETE_ENTRY");
    expect(phaseA47FinalEngineering).toContain("A47_DUPLICATE_OPERATION_KEY");
    expect(phaseA47FinalEngineering).toContain("A47_GL_RPC_EXPOSED_TO_CLIENT_ROLE");
    expect(phaseA47FinalEngineering).toContain("A47_STAGING_SCOPE_BYPASS");
    expect(phaseA47FinalEngineering).toContain("A47_BOOTSTRAP_NOT_BOUNDED");
    expect(phaseA47FinalEngineering).toContain("NOT_CERTIFIED");
    expect(phaseA47FinalEngineering).toContain("ROLLBACK;");
    expect(phaseA47FinalEngineering).not.toMatch(/\\bCOMMIT\\s*;/i);
    expect(phaseA47AcceptanceReport).toContain("not a financial attestation");
    expect(phaseA47AcceptanceReport).toContain("READ ONLY");
    expect(phaseA47AcceptanceReport).toContain("21 committed GL entries");
  });

  it("builds phase-B1 GL statement projection with strict non-certified site scoping", () => {
    expect(financialStatementsB1Sql).toContain("powerhub_financial_gl_site_statements");
    expect(financialStatementsB1Sql).toContain("GL_B1_UNMAPPED_INCOME_OR_EXPENSE");
    expect(financialStatementsB1Sql).toContain("GL_B1_FINANCIAL_EQUATION_UNBALANCED");
    expect(financialStatementsB1Sql).toContain("NOT_CONFIGURED_OR_APPROVED");
    expect(financialStatementsB1Sql).toContain("NOT_CONSOLIDATED");
    expect(financialStatementsB1Acceptance).toContain("B1_CROSS_TENANT_BYPASS");
    expect(financialStatementsB1Acceptance).toContain("B1_RPC_EXPOSED_TO_PUBLIC");
    expect(financialStatementsB1Acceptance).toContain("PASS_ROLLBACK_ONLY");
    expect(financialStatementsB1Ui).toContain("B1 — قائمة الدخل والمركز المالي الأوليان");
    expect(financialStatementsB1Ui).toContain("enabled:enabled && showB1");
    expect(runtime).toContain("financialGLSiteStatements: protectedProcedure");
    expect(runtime).toContain("powerhub_financial_gl_site_statements");
    expect(runtime).toContain("viewFinancialReports");
  });

  it("safeguards B2 central policy preparation, independent review and management-only reporting", () => {
    expect(phaseB2CentralPolicySql).toContain("powerhub_financial_gl_central_pool_check");
    expect(phaseB2CentralPolicySql).toContain("B2_WEIGHTS_NOT_100_PERCENT");
    expect(phaseB2CentralPolicySql).toContain("B2_SELF_APPROVAL_DENIED");
    expect(phaseB2CentralPolicySql).toContain("B2_IMMUTABLE");
    expect(phaseB2CentralPolicySql).toContain("doesNotPostGL");
    expect(phaseB2CentralPolicyAcceptance).toContain("B2_PASS_ROLLBACK_ONLY");
    expect(phaseB2CentralPolicyAcceptance).toContain("B2_TENANT_BYPASS");
    expect(phaseB2CentralPolicyAcceptance).toContain("B2_PUBLIC_EXECUTE");
    expect(phaseB2CentralPolicyAcceptance).toContain("ROLLBACK;");
    expect(runtime).toContain("financialGLCentralPolicyPreview: protectedProcedure");
    expect(runtime).toContain("financialGLCentralPolicyPrepare: protectedProcedure");
    expect(runtime).toContain("financialGLCentralPolicyApprove: protectedProcedure");
  });

  it("keeps B3 preliminary tenant rollup distinct from certified consolidation", () => {
    expect(b3TenantRollupSql).toContain("PRELIMINARY_MULTI_SITE_ROLLUP");
    expect(b3TenantRollupSql).toContain("GL_B3_AGGREGATE_UNBALANCED");
    expect(b3TenantRollupSql).toContain("NOT_INDEPENDENTLY_RECONCILED");
    expect(b3TenantRollupCheck).toContain("B3_PASS_ROLLBACK_ONLY");
    expect(b3TenantRollupCheck).toContain("B3_EXPOSED_TO_PUBLIC");
    expect(b3TenantRollupCheck).toContain("ROLLBACK;");
    expect(runtime).toContain("financialGLTenantRollup: protectedProcedure");
    expect(runtime).toContain('v.companyAccountsIncluded!==false');
  });

  it("renders B3 rollup only on demand with explicit non-certification", () => {
    expect(glAuditUiA45).toContain("financialGLTenantRollup.useQuery");
    expect(glAuditUiA45).toContain("enabled:enabled && showB3");
    expect(glAuditUiA45).toContain("B3 — إجمالي الفروع الأولي قبل التسويات");
    expect(glAuditUiA45).toContain("b3Visible");
    expect(glAuditUiA45).toContain("rollup.isError");
  });

  it("guards B4.2 movement provenance and never silently excludes unverified fixture rows", () => {
    expect(companyMovementB42Sql).toContain("powerhub_financial_gl_company_movement_audit");
    expect(companyMovementB42Sql).toContain("powerhub_financial_gl_verify_staging_fixture");
    expect(companyMovementB42Sql).toContain("UNVERIFIED_COHORT_BLOCKS_RECONCILIATION");
    expect(companyMovementB42Sql).toContain("MISSING_OR_DUPLICATE_GL_ENTRY");
    expect(companyMovementB42Sql).toContain("GL_CASH_SIDE_AMOUNT_OR_PERIOD_MISMATCH");
    expect(companyMovementB42Sql).toContain("NOT_CERTIFIED");
    expect(companyMovementB42Sql).toContain("TO service_role");
    expect(companyMovementB42Acceptance).toContain("B4_2_PASS_ROLLBACK_ONLY");
    expect(companyMovementB42Acceptance).toContain("B4_2_TENANT_BYPASS");
    expect(companyMovementB42Acceptance).toContain("B4_2_RPC_EXECUTE_EXPOSURE");
    expect(companyMovementB42Acceptance).toContain("ROLLBACK;");
    expect(runtime).toContain("financialGLCompanyMovementAudit: protectedProcedure");
    expect(runtime).toContain("powerhub_financial_gl_company_movement_audit");
    expect(glAuditUiA45).toContain("financialGLCompanyMovementAudit.useQuery");
    expect(glAuditUiA45).toContain("enabled:enabled && showB4Cash");
    expect(glAuditUiA45).toContain("B4 — مطابقة حركات حسابات الشركة ومستنداتها");
    expect(glAuditUiA45).toContain("b4Cash.isError");
  });

  it("guards B4.1 document-source auditing and never labels it certified", () => {
    expect(b4DocumentSourceSql).toContain("powerhub_financial_gl_subledger_document_audit");
    expect(b4DocumentSourceSql).toContain("GL_B4_DOCUMENT_INVALID_SCOPE");
    expect(b4DocumentSourceSql).toContain("BLOCKED_DOCUMENT_RECONCILIATION");
    expect(b4DocumentSourceSql).toContain("NOT_CERTIFIED");
    expect(b4DocumentSourceSql).toContain("REVOKE ALL");
    expect(b4DocumentSourceSql).toContain("TO service_role");
    expect(b4DocumentSourceRegression).toContain("B4_1_PASS_ROLLBACK_ONLY");
    expect(b4DocumentSourceRegression).toContain("B4_1_CROSS_TENANT_BYPASS");
    expect(b4DocumentSourceRegression).toContain("B4_1_RPC_EXECUTE_EXPOSURE");
    expect(b4DocumentSourceRegression).toContain("ROLLBACK;");
    expect(runtime).toContain("financialGLSubledgerDocumentAudit: protectedProcedure");
    expect(runtime).toContain("powerhub_financial_gl_subledger_document_audit");
    expect(runtime).toContain('"viewFinancialReports"');
    expect(glAuditUiA45).toContain("financialGLSubledgerDocumentAudit.useQuery");
    expect(glAuditUiA45).toContain("enabled:enabled && showB4Documents");
    expect(glAuditUiA45).toContain("B4 — تدقيق مصادر القيود والمستندات");
    expect(glAuditUiA45).toContain("b4Documents.isError");
  });

  it("gates B2 allocation workflow on scoped server permissions and independent approval", () => {
    expect(runtime).toContain("financialGLCentralPolicyWorkspace: protectedProcedure");
    expect(runtime).toContain("financial_gl_central_allocation_policies");
    expect(runtime).toContain("financialGLCentralPolicyApprove: protectedProcedure");
    expect(runtime).toContain("policyError || !rows || rows.length!==1");
    expect(financialCentralB2Ui).toContain("toBasisPoints");
    expect(financialCentralB2Ui).toContain("totalPoints === 10000");
    expect(financialCentralB2Ui).toContain("sourceCandidatesTruncated");
    expect(financialCentralB2Ui).toContain("preparedAcknowledged");
    expect(financialCentralB2Ui).toContain("reviewAcknowledged");
    expect(financialCentralB2Ui).toContain("operationKey");
    expect(financialCentralB2Ui).toContain("workspace.refetch()");
    expect(glAuditUiA45).toContain("<FinancialCentralAllocationWorkspace");
  });

});
