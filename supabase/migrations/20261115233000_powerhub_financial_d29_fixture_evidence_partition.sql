-- D29: read-only evidence partition for the ONE A35/B54 hash-anchored,
-- frozen, Staging-only technical performance cohort. NOT an accounting exemption.
-- No D28 rewrites, no deletion, no journal posting, no balance adjustments.
-- A fast proof reuses an earlier full SHA verification and active write guards;
-- it is NOT a new SHA recomputation or independent human attestation.
CREATE OR REPLACE FUNCTION public.powerhub_financial_d29_fixture_evidence_partition(
 p_tenant_id bigint,p_period text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path TO 'pg_catalog','public','pg_temp'
AS $fn$
DECLARE
 v_raw jsonb;
 v_proof jsonb:='{}'::jsonb;
 v_cutoff timestamptz;
 v_total bigint;v_linked bigint;v_invalid bigint;v_unlinked bigint;v_transfers bigint;
 v_technical bigint:=0;v_remaining bigint;
 v_eligible boolean:=false;v_verified boolean:=false;
 v_blockers jsonb:='[]'::jsonb;
 v_partition_status text;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_period IS NULL
 OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 THEN RAISE EXCEPTION 'D29_INVALID_TENANT_OR_PERIOD' USING ERRCODE='22023'; END IF;
 v_raw:=public.powerhub_financial_cash_source_gl_chain(p_tenant_id,p_period);
 v_cutoff:=(((p_period||'-01')::date+interval '1 month')::timestamp
  AT TIME ZONE 'Asia/Gaza');
 IF v_raw IS NULL
 OR (v_raw->>'tenantId')::bigint IS DISTINCT FROM p_tenant_id
 OR v_raw->>'period' IS DISTINCT FROM p_period
 OR v_raw->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 OR v_raw->>'independentFullLedgerReconciliation' IS DISTINCT FROM 'false'
 OR v_raw->>'glCashLegOnlyProof' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'D29_UNTRUSTWORTHY_UPSTREAM_SOURCE_REPORT'
 USING ERRCODE='23514'; END IF;
 v_total:=(v_raw->>'totalCashMovementCount')::bigint;
 v_linked:=(v_raw->>'explicitSourceLinkedMovementCount')::bigint;
 v_invalid:=(v_raw->>'unverifiedSourceCashGlMovementCount')::bigint;
 v_unlinked:=(v_raw->>'unlinkedNonTransferCashMovementCount')::bigint;
 v_transfers:=(v_raw->>'internalTransferMovementCount')::bigint;
 IF v_total IS NULL OR v_linked IS NULL OR v_invalid IS NULL
 OR v_unlinked IS NULL OR v_transfers IS NULL
 OR least(v_total,v_linked,v_invalid,v_unlinked,v_transfers)<0
 OR v_total<>v_linked+v_unlinked+v_transfers
 OR v_invalid>v_linked
 THEN RAISE EXCEPTION 'D29_SOURCE_COVERAGE_COUNTS_INCONSISTENT'
 USING ERRCODE='23514';END IF;

 -- D29 classification applies ONLY to the complete May 2026 cohort in tenant 1.
 -- A partial date interval must not use the 250k manifest to subtract 250k.
 v_eligible:=p_tenant_id=1
   AND v_cutoff>'2026-05-03T20:50:00+00'::timestamptz;
 IF v_eligible THEN
  v_proof:=public.powerhub_financial_gl_fast_staging_fixture_proof(1,1);
  v_verified:=coalesce((v_proof->>'verified')::boolean,false)
    AND (v_proof->>'quarantinedCount')::bigint=250000
    AND v_proof->>'verificationMode'='STAGING_PRELAUNCH_TECHNICAL'
    AND v_proof->>'humanReviewed'='false'
    AND v_proof->>'retainedRawRows'='true'
    AND v_proof->>'financialCertification'='NOT_CERTIFIED'
    AND v_proof->>'sha256'='f1b25e8562328a0f6e916beb4d54b2ee88366e78b4459c5d0ebc444616997df9';
  IF v_verified AND v_unlinked>=250000
    AND (v_raw->>'technicalPerformancePrefixMovementCountNotExcluded')::bigint=250000
  THEN
    v_technical:=250000;
  ELSE
    v_verified:=false;
    v_blockers:=v_blockers||'"KNOWN_TECHNICAL_COHORT_EVIDENCE_MISSING_OR_DRIFTED"'::jsonb;
  END IF;
 END IF;
 v_remaining:=v_unlinked-v_technical;
 IF v_remaining<0 THEN RAISE EXCEPTION 'D29_NEGATIVE_UNLINKED_PARTITION'
 USING ERRCODE='23514';END IF;
 IF v_remaining>0 THEN
   v_blockers:=v_blockers||'"UNLINKED_NON_TECHNICAL_OR_UNCLASSIFIED_CASH_MOVEMENTS"'::jsonb;
 END IF;
 IF v_invalid>0 THEN
   v_blockers:=v_blockers||'"SOURCE_TO_GL_CASH_PROOF_MISMATCH"'::jsonb;
 END IF;
 IF v_transfers>0 THEN
   v_blockers:=v_blockers||'"INTERNAL_TRANSFERS_NOT_PROVEN_BY_D29"'::jsonb;
 END IF;
 v_partition_status:=CASE
 WHEN v_technical>0 AND v_remaining=0 AND v_invalid=0 AND v_transfers=0
 THEN 'PRELIMINARY_TECHNICAL_COHORT_SEPARATED'
 ELSE 'BLOCKED_SOURCE_COVERAGE_OR_EVIDENCE' END;

 RETURN jsonb_build_object(
  'tenantId',p_tenant_id,'period',p_period,'asOfExclusive',v_cutoff,
  'partitionStatus',v_partition_status,
  'sourceReportStatus',v_raw->>'status',
  'rawAccountMovementCount',v_total,
  'rawExplicitSourceLinkedCount',v_linked,
  'rawUnlinkedNonTransferMovementCount',v_unlinked,
  'rawInternalTransferMovementCount',v_transfers,
  'rawSourceCashGlMismatchCount',v_invalid,
  'verifiedTechnicalFixtureMovementCountForAnalysisOnly',v_technical,
  'unlinkedMovementCountAfterEvidencePartitionNotCertified',v_remaining,
  'technicalFixtureEvidenceMode',CASE WHEN v_technical=250000
    THEN 'PREVIOUS_FULL_SHA_ANCHORED_WITH_LIVE_FREEZE_GUARDS'
    ELSE 'NONE_VERIFIED_FOR_REQUESTED_SCOPE' END,
  'fullShaRecomputedOnThisRequest',false,
  'humanReviewedTechnicalFixture',false,
  'rawRowsRetained',true,
  'changesLedgerOrCashBalances',false,
  'technicalPartitionAuthorizesAccountingExclusion',false,
  'verifiedSourceCashGlMovementCount',(v_raw->>'verifiedSourceCashGlMovementCount')::bigint,
  'independentFullLedgerReconciliation',false,
  'openingBalanceEvidenceApproved',false,
  'canBeCertifiedFinancialStatements',false,
  'accountingCertification','NOT_CERTIFIED',
  'blockers',v_blockers,
  'technicalProofReason',coalesce(v_proof->>'reason','NOT_CHECKED_OUTSIDE_EXACT_SCOPE'));
END $fn$;
REVOKE ALL ON FUNCTION public.powerhub_financial_d29_fixture_evidence_partition(bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_d29_fixture_evidence_partition(bigint,text)
 TO service_role;
COMMENT ON FUNCTION public.powerhub_financial_d29_fixture_evidence_partition(bigint,text)
 IS 'D29 read-only, staging-only technical cohort evidence partition. Historical cash and financial GL are unchanged; no accounting exclusion or certification.';