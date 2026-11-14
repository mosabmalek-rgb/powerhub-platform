-- B5: end-to-end read-only GL acceptance gate for the *synthetic* Staging tenant.
-- Numerical test-opening correction does NOT certify any financial statements.
-- Run against Staging inside a rolled-back transaction. Must not be used as a
-- production seed, human approval, or replacement for browser/parallel sessions.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $b5$
DECLARE
  roll jsonb;
  site_1 jsonb;
  site_2 jsonb;
  account_1 jsonb;
  doc_1 jsonb;
  cash_1 jsonb;
  account_2 jsonb;
  doc_2 jsonb;
  cash_2 jsonb;
  coverage jsonb;
  bad_entries bigint;
  t0 timestamptz := clock_timestamp();
BEGIN
  IF (SELECT count(*) FROM public.sites
      WHERE tenant_id=1 AND status='active')<>2
    OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>25
    OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>51
    OR EXISTS (SELECT 1 FROM public.financial_gl_central_allocation_policies
       WHERE tenant_id=1)
  THEN RAISE EXCEPTION 'B5_STAGING_BASELINE_CHANGED'; END IF;

  SELECT count(*) INTO bad_entries FROM (
    SELECT e.id, sum(CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END) AS net
    FROM public.financial_gl_entries e
    JOIN public.financial_gl_lines l
      ON l.entry_id=e.id AND l.tenant_id=e.tenant_id AND l.site_id=e.site_id
    WHERE e.tenant_id=1
    GROUP BY e.id
    HAVING sum(CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END)<>0
  ) discrepancies;
  IF bad_entries<>0 THEN RAISE EXCEPTION 'B5_UNBALANCED_GL_ENTRY';END IF;

  roll:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
  site_1:=public.powerhub_financial_gl_site_statements(1,1,'2026-11');
  site_2:=public.powerhub_financial_gl_site_statements(1,9000000000099,'2026-11');
  coverage:=public.powerhub_financial_gl_source_coverage(1,1,'2026-11');
  account_1:=public.powerhub_financial_gl_subledger_reconciliation(1,1,'2026-11');
  doc_1:=public.powerhub_financial_gl_subledger_document_audit(1,1,'2026-11');
  cash_1:=public.powerhub_financial_gl_company_movement_audit(1,1,'2026-11');
  account_2:=public.powerhub_financial_gl_subledger_reconciliation(1,9000000000099,'2026-11');
  doc_2:=public.powerhub_financial_gl_subledger_document_audit(1,9000000000099,'2026-11');
  cash_2:=public.powerhub_financial_gl_company_movement_audit(1,9000000000099,'2026-11');

  IF roll->>'status'<>'PRELIMINARY_MULTI_SITE_ROLLUP'
     OR roll->>'accountingCertification'<>'NOT_CERTIFIED'
     OR (roll->>'isConsolidatedFinancialStatements')::boolean IS DISTINCT FROM false
     OR (roll->>'siteCount')::bigint<>2
     OR (roll->>'glEntryCount')::bigint<>25
     OR (roll->>'intraSiteWarehouseTransferCount')::bigint<>2
     OR (roll->>'intraSiteWarehouseTransferValue')::numeric<>170
     OR (roll->>'intraSiteWarehouseTransferMismatchCount')::bigint<>0
     OR (roll->'readiness'->>'warehouseTransfersPaired')::boolean IS DISTINCT FROM true
     OR roll->>'warehouseTransferClassification'<>'INTRA_SITE_STOCK_TRANSFER_NOT_GL_ELIMINATION'
     OR (roll->>'interSiteTransferCandidateCount')::bigint<>0
     OR (roll->>'companyTransferSourceOperationCount')::bigint<>0
     OR (roll->>'crossSiteOperationalTransferCount')::bigint<>0
     OR (roll->>'invalidOperationalTransferPairCount')::bigint<>0
     OR roll->>'interSiteSourceEvidenceStatus'<>'NO_CROSS_SITE_SOURCE_OBSERVED_NOT_CERTIFIED'
     OR (roll->'readiness'->>'interSiteSourcePairIntegrity')::boolean IS DISTINCT FROM true
     OR roll->>'interSiteTransferEliminationStatus'<>'NOT_INDEPENDENTLY_RECONCILED'
     OR (roll->'readiness'->>'canBeCertifiedConsolidation')::boolean IS DISTINCT FROM false
     OR (roll->'positionBeforeEliminations'->>'equationDifference')::numeric<>0
  THEN RAISE EXCEPTION 'B5_UNTRUTHFUL_CONSOLIDATION'; END IF;
  IF site_1->>'accountingCertification'<>'NOT_CERTIFIED'
     OR site_2->>'accountingCertification'<>'NOT_CERTIFIED'
     OR (site_1->>'isFinalBalanceSheet')::boolean IS DISTINCT FROM false
     OR (site_2->>'isFinalBalanceSheet')::boolean IS DISTINCT FROM false
  THEN RAISE EXCEPTION 'B5_FALSE_FINAL_SITE_STATEMENT'; END IF;
  IF coverage->>'accountingCertification'<>'NOT_CERTIFIED'
     OR (coverage->'technicalAcceptance'->>'isEngineeringAccepted')::boolean IS DISTINCT FROM true
     OR (coverage->'technicalAcceptance'->>'isFinalFinancialAcceptance')::boolean IS DISTINCT FROM false
  THEN RAISE EXCEPTION 'B5_TECHNICAL_VS_FINANCIAL_ACCEPTANCE_CONFUSED'; END IF;

  IF account_1->>'status'<>'MATCHED_NUMERICALLY_NOT_CERTIFIED'
     OR (account_1->>'unresolvedCount')::bigint<>0
     OR (account_1->>'differenceCount')::bigint<>0
     OR jsonb_array_length(account_1->'checks')<>5
     OR EXISTS(
        SELECT 1 FROM jsonb_array_elements(account_1->'checks') j
        WHERE j->>'status'<>'MATCHED' OR (j->>'difference')::numeric<>0
     )
     OR doc_1->>'status'<>'DOCUMENT_SOURCES_MATCHED_NOT_CERTIFIED'
     OR (doc_1->>'sourceCount')::bigint<>16
     OR (doc_1->>'mismatchCount')::bigint<>0
     OR (doc_1->>'orphanGLEntryCount')::bigint<>0
     OR cash_1->>'status'<>'LINKED_ACCOUNT_MOVEMENTS_MATCH_NOT_CERTIFIED'
     OR (cash_1->>'linkedMovementCount')::bigint<>9
     OR (cash_1->>'mismatchCount')::bigint<>0
     OR (cash_1->>'orphanOperationalSourceCount')::bigint<>0
     OR (cash_1->>'unlinkedNonFixtureMovementCount')::bigint<>0
     OR (cash_1->>'fixtureExcludedCount')::bigint<>250000
     OR cash_1->>'fixtureVerificationStatus'<>'HASH_ANCHORED_IMMUTABLE_TEST_COHORT'
  THEN RAISE EXCEPTION 'B5_PRIMARY_SITE_RECONCILIATION_REGRESSION'; END IF;

  -- B4.10: the synthetic opening was corrected by append-only GL reversal.
  -- Audit, exact provenance, numerical matching and lack of human approval remain explicit.
  IF account_2->>'status'<>'MATCHED_NUMERICALLY_NOT_CERTIFIED'
     OR (account_2->>'differenceCount')::bigint<>0
     OR (account_2->>'unresolvedCount')::bigint<>0
     OR jsonb_array_length(account_2->'checks')<>5
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(account_2->'checks') j
          WHERE j->>'status'<>'MATCHED' OR (j->>'difference')::numeric<>0)
     OR doc_2->>'status'<>'DOCUMENT_SOURCES_MATCHED_NOT_CERTIFIED'
     OR (doc_2->>'mismatchCount')::bigint<>0
     OR cash_2->>'status'<>'LINKED_ACCOUNT_MOVEMENTS_MATCH_NOT_CERTIFIED'
     OR (cash_2->>'aggregateUnresolvedCount')::bigint<>0
     OR NOT EXISTS(SELECT 1 FROM public.financial_gl_entries e
          JOIN public.financial_gl_entries original ON original.id=e.reverses_entry_id
          WHERE e.tenant_id=1 AND e.site_id=9000000000099
            AND e.source_type='correction' AND e.reverses_entry_id=168
            AND e.operation_key='gl:correction:staging-opening19:technical:v1'
            AND e.accounting_policy_version='staging-prelaunch-technical-disposition-v1'
            AND original.source_type='opening_balance' AND original.source_id='19'
            AND original.source_fingerprint='56991cd37e9f908daac5853fc1ca64cbc5bdb7f92f3c399c31713c4e1dd1048e')
     OR (SELECT count(*) FROM public.audit_logs a
          JOIN public.financial_gl_entries e ON e.id=a.entity_id::bigint
          WHERE a.tenant_id=1 AND a.site_id=9000000000099
            AND a.action='STAGING_PRELAUNCH_TEST_OPENING_TECHNICAL_REVERSAL'
            AND a.user_id IS NULL AND a.after_data->>'humanApproved'='false'
            AND a.after_data->>'accountingCertification'='NOT_CERTIFIED'
            AND e.reverses_entry_id=168)<>1
     OR EXISTS (SELECT 1 FROM public.financial_gl_opening_evidence
        WHERE tenant_id=1 AND site_id=9000000000099)
     OR EXISTS (SELECT 1 FROM public.financial_gl_opening_document_custody
        WHERE tenant_id=1 AND site_id=9000000000099)
     OR public.powerhub_financial_gl_opening_evidence_status(1,9000000000099,'2026-11')->>'isIndependentlyReconciled'<>'false'
  THEN RAISE EXCEPTION 'B5_SYNTHETIC_OPENING_DISPOSITION_INTEGRITY_FAILURE'; END IF;
  IF EXISTS(SELECT 1 FROM pg_proc f WHERE f.pronamespace='public'::regnamespace
      AND f.proname IN (
        'powerhub_financial_gl_tenant_rollup',
        'powerhub_financial_gl_subledger_reconciliation',
        'powerhub_financial_gl_subledger_document_audit',
        'powerhub_financial_gl_company_movement_audit',
        'powerhub_financial_gl_central_policy_prepare',
        'powerhub_financial_gl_central_policy_approve',
        'powerhub_financial_gl_central_policy_preview'
      ) AND
      (has_function_privilege('anon',f.oid,'EXECUTE')
       OR has_function_privilege('authenticated',f.oid,'EXECUTE')
       OR NOT has_function_privilege('service_role',f.oid,'EXECUTE')))
  THEN RAISE EXCEPTION 'B5_GL_RPC_PERMISSION_DRIFT';END IF;
  RAISE NOTICE 'B5_ENGINEERING_PASS_NOT_FINANCIAL_CERTIFICATION elapsed_ms=%',
    round(extract(epoch FROM clock_timestamp()-t0)*1000,2);
END;
$b5$;
SELECT 'B5_STAGING_ENGINEERING_GATE_PASS_NOT_CERTIFIED' AS result;
ROLLBACK;
