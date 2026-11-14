-- A45 applied on Staging as 20261110170636. Technical acceptance is NOT financial certification.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_source_coverage(p_tenant_id bigint, p_site_id bigint, p_period text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_report jsonb;v_verified jsonb;v_count bigint;v_cash jsonb;
 v_unclassified bigint;v_missing bigint;v_new_missing bigint;
 v_a45_accepted boolean:=false; v_a45_marker boolean:=false;v_a45_audit boolean:=false;
 v_a45_total bigint:=0;v_a45_operational bigint:=0;v_a45_services bigint:=0;
 v_a45_balance numeric:=0;v_a45_opening bigint:=0;
BEGIN
 v_report:=public.powerhub_financial_gl_source_coverage_raw(
   p_tenant_id,p_site_id,p_period);
 IF p_period='2026-05' THEN
  v_verified:=public.powerhub_financial_gl_verify_staging_fixture(
     p_tenant_id,p_site_id);
  IF (v_verified->>'verified')::boolean IS TRUE THEN
   v_count:=(v_verified->>'quarantinedCount')::bigint;
   v_cash:=v_report->'sources'->'companyAccountMovements';
   v_unclassified:=(v_cash->>'unclassified')::bigint;
   v_missing:=(v_report->>'unreconciledSourceCount')::bigint;
   IF v_unclassified>=v_count AND v_missing>=v_count THEN
    v_new_missing:=v_missing-v_count;
    v_cash:=jsonb_set(v_cash,'{unclassified}',
       to_jsonb(v_unclassified-v_count))
       ||jsonb_build_object('quarantinedTestMovements',v_count,
                           'fixtureQuarantine',v_verified);
    v_report:=jsonb_set(v_report,'{sources,companyAccountMovements}',v_cash);
    v_report:=jsonb_set(v_report,'{unreconciledSourceCount}',to_jsonb(v_new_missing));
    v_report:=jsonb_set(v_report,'{isSourceCoverageComplete}',to_jsonb(
        v_new_missing=0
        AND (v_report->'sourceIntegrity'->>'isClean')::boolean IS TRUE
        AND (v_report->'opening'->>'postedCount')::bigint=1
        AND (v_report->'opening'->>'draftCount')::bigint=0));
   END IF;
  END IF;
 END IF;
 IF p_tenant_id=1 AND p_site_id=1 AND p_period='2026-11' THEN
 SELECT count(*),count(*) FILTER(WHERE source_type<>'service_recognition'),
        count(*) FILTER(WHERE source_type='service_recognition')
 INTO v_a45_total,v_a45_operational,v_a45_services
 FROM public.financial_gl_entries WHERE tenant_id=p_tenant_id AND site_id=p_site_id;
 SELECT coalesce(sum(CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END),0)
 INTO v_a45_balance FROM public.financial_gl_lines l JOIN public.financial_gl_entries e ON e.id=l.entry_id
 WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id;
 SELECT count(*) INTO v_a45_opening FROM public.financial_gl_opening_batches
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id;
 SELECT EXISTS(SELECT 1 FROM public.financial_gl_prelaunch_technical_bootstrap b
 JOIN public.financial_gl_staging_technical_exclusions x ON x.tenant_id=b.tenant_id
 AND x.site_id=b.site_id AND x.cohort_key=b.cohort_key
 AND x.sha256=b.manifest_sha256 AND x.row_count=b.fixture_row_count
 WHERE b.tenant_id=p_tenant_id AND b.site_id=p_site_id
 AND b.mode='PRELAUNCH_TECHNICAL' AND b.human_approved=false
 AND b.as_of_date=DATE '2026-09-30' AND b.accounting_certification='NOT_CERTIFIED')
 INTO v_a45_marker;
 SELECT EXISTS(SELECT 1 FROM public.audit_logs a
 WHERE a.tenant_id=p_tenant_id AND a.site_id=p_site_id
 AND a.action='STAGING_PRELAUNCH_GL_TECHNICAL_POSTING_A44'
 AND a.entity_type='financial_gl_prelaunch_technical_bootstrap'
 AND a.entity_id='1' AND a.user_id IS NULL
 AND a.after_data->>'humanApproved'='false'
 AND a.after_data->>'accountingCertification'='NOT_CERTIFIED'
 AND a.after_data->>'glEntries'='21'
 AND a.after_data->>'postedOperationalSources'='18'
 AND a.after_data->>'postedServiceRecognitions'='3'
 AND a.metadata->>'actorIdDoesNotConstituteHumanApproval'='true') INTO v_a45_audit;
 v_a45_accepted:=v_a45_marker AND v_a45_audit AND v_a45_total=21
  AND v_a45_operational=18 AND v_a45_services=3 AND v_a45_balance=0
  AND v_a45_opening=0
  AND (v_report->>'unreconciledSourceCount')::bigint=0
  AND (v_report->'sourceIntegrity'->>'isClean')::boolean IS TRUE
  AND v_report->>'accountingCertification'='NOT_CERTIFIED'
  AND (v_report->>'isOpeningReconciled')::boolean IS FALSE
  AND (v_report->>'isSourceCoverageComplete')::boolean IS FALSE;
 END IF;
 RETURN v_report || jsonb_build_object('technicalAcceptance',jsonb_build_object(
 'status',CASE WHEN v_a45_accepted THEN 'PASS_PRELAUNCH_ENGINEERING_ONLY'
      WHEN p_tenant_id=1 AND p_site_id=1 AND p_period='2026-11' THEN 'NOT_ACCEPTED'
      ELSE 'NOT_APPLICABLE' END,
 'isEngineeringAccepted',v_a45_accepted,'postedGL',v_a45_total,
 'operationalSources',v_a45_operational,'serviceRecognitionEntries',v_a45_services,
 'balanceDifference',v_a45_balance,'documentedOpeningCount',v_a45_opening,
 'technicalFixtureProven',v_a45_marker,'technicalAuditRecorded',v_a45_audit,
 'humanApproved',false,'accountingCertification','NOT_CERTIFIED',
 'isFinalFinancialAcceptance',false,'scope','STAGING_PRELAUNCH_TECHNICAL'));
END;
$function$
;
