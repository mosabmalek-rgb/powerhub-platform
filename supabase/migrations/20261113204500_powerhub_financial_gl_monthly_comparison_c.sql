-- Phase C: same-scope, single-statement GL comparison; no certified statements.
-- This read-only RPC reuses the existing posted-GL B1 source and fails closed.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_monthly_comparison(
  p_tenant_id bigint, p_site_id bigint, p_current_period text, p_previous_period text
) RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 v_current jsonb;
 v_previous jsonb;
 v_cur_policy text;
 v_prev_policy text;
 v_cur_count integer;
 v_prev_count integer;
 v_cur_missing bigint;
 v_prev_missing bigint;
 v_blockers text[] := ARRAY[]::text[];
 v_fingerprint text;
 v_site_name text;
 v_tenant_name text;
 v_cur_review text;
 v_prev_review text;
BEGIN
 IF p_tenant_id IS NULL OR p_site_id IS NULL OR p_tenant_id<=0 OR p_site_id<=0
    OR p_current_period IS NULL OR p_previous_period IS NULL
    OR p_current_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    OR p_previous_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    OR p_previous_period >= p_current_period
    OR NOT EXISTS(
      SELECT 1 FROM public.sites s
      WHERE s.id=p_site_id AND s.tenant_id=p_tenant_id AND s.status<>'archived')
 THEN RAISE EXCEPTION 'GL_C_INVALID_SCOPE_OR_PERIOD' USING ERRCODE='22023';
 END IF;
 -- Calendar-month comparison, independent of varying month lengths/DST in Gaza.
 PERFORM (p_current_period || '-01')::date;
 PERFORM (p_previous_period || '-01')::date;

 SELECT s.name,t.name INTO STRICT v_site_name,v_tenant_name
 FROM public.sites s JOIN public.tenants t ON t.id=s.tenant_id
 WHERE s.id=p_site_id AND s.tenant_id=p_tenant_id;

 -- Both STABLE nested RPCs and the provenance checks use the invoking statement snapshot.
 v_current:=public.powerhub_financial_gl_site_statements(p_tenant_id,p_site_id,p_current_period);
 v_previous:=public.powerhub_financial_gl_site_statements(p_tenant_id,p_site_id,p_previous_period);

 SELECT count(DISTINCT NULLIF(e.accounting_policy_version,'')),
        min(NULLIF(e.accounting_policy_version,'')),
        count(*) FILTER (WHERE NULLIF(e.accounting_policy_version,'') IS NULL)
 INTO v_cur_count,v_cur_policy,v_cur_missing
 FROM public.financial_gl_entries e
 WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
   AND e.period=p_current_period AND e.source_type='service_recognition';

 SELECT count(DISTINCT NULLIF(e.accounting_policy_version,'')),
        min(NULLIF(e.accounting_policy_version,'')),
        count(*) FILTER (WHERE NULLIF(e.accounting_policy_version,'') IS NULL)
 INTO v_prev_count,v_prev_policy,v_prev_missing
 FROM public.financial_gl_entries e
 WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
   AND e.period=p_previous_period AND e.source_type='service_recognition';

 IF v_cur_count<>1 OR v_prev_count<>1 OR v_cur_missing<>0 OR v_prev_missing<>0
 THEN v_blockers:=array_append(v_blockers,'RECOGNITION_POLICY_NOT_PROVEN');
 ELSIF v_cur_policy<>v_prev_policy
 THEN v_blockers:=array_append(v_blockers,'RECOGNITION_POLICY_MISMATCH');
 END IF;
 IF (v_current->>'hasPostedData')::boolean IS DISTINCT FROM true
    OR (v_previous->>'hasPostedData')::boolean IS DISTINCT FROM true
 THEN v_blockers:=array_append(v_blockers,'NO_POSTED_GL_IN_ONE_PERIOD');END IF;
 IF (v_current->>'isSourceCoverageComplete')::boolean IS DISTINCT FROM true
    OR (v_previous->>'isSourceCoverageComplete')::boolean IS DISTINCT FROM true
 THEN v_blockers:=array_append(v_blockers,'UNVERIFIED_SOURCE_COVERAGE');END IF;
 IF coalesce((v_current->>'unreconciledSourceCount')::bigint,-1)<>0
    OR coalesce((v_previous->>'unreconciledSourceCount')::bigint,-1)<>0
 THEN v_blockers:=array_append(v_blockers,'UNRECONCILED_GL_SOURCE');END IF;

 -- No pagination/caps: account totals are returned by B1's complete PostgreSQL aggregate.
 -- The digest additionally covers all GL entry provenance and line amounts up to the latest period.
 SELECT md5(coalesce(string_agg(
   concat(e.id,':',e.period,':',e.source_type,':',e.source_id,':',
          e.source_revision,':',e.source_fingerprint,':',
          e.accounting_policy_version,':',e.reverses_entry_id,':',
          coalesce((
            SELECT string_agg(concat(l.id,':',l.account_code,':',l.side,':',l.amount),
                              '|' ORDER BY l.id)
            FROM public.financial_gl_lines l
            WHERE l.entry_id=e.id AND l.tenant_id=e.tenant_id AND l.site_id=e.site_id
          ),'')
   ),chr(10) ORDER BY e.id),'NO_GL_POSTINGS')
   ||':'||p_tenant_id||':'||p_site_id||':'||p_current_period||':'||p_previous_period)
 INTO v_fingerprint
 FROM public.financial_gl_entries e
 WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id AND e.period<=p_current_period;

 -- Cover source-coverage/approval changes as well as posted GL line mutations.
 v_fingerprint:=md5(v_fingerprint||':'||v_current::text||':'||v_previous::text);

 SELECT coalesce((SELECT r.status FROM public.financial_accrual_period_reviews r
                 WHERE r.tenant_id=p_tenant_id AND r.site_id=p_site_id
                   AND r.period=p_current_period ORDER BY r.id DESC LIMIT 1),'UNREVIEWED')
 INTO v_cur_review;
 SELECT coalesce((SELECT r.status FROM public.financial_accrual_period_reviews r
                 WHERE r.tenant_id=p_tenant_id AND r.site_id=p_site_id
                   AND r.period=p_previous_period ORDER BY r.id DESC LIMIT 1),'UNREVIEWED')
 INTO v_prev_review;

 v_fingerprint:=md5(v_fingerprint||':'||v_cur_review||':'||v_prev_review);

 RETURN jsonb_build_object(
   'tenantId',p_tenant_id,'siteId',p_site_id,'tenantName',v_tenant_name,
   'siteName',v_site_name,'currentPeriod',p_current_period,
   'previousPeriod',p_previous_period,'current',v_current,'previous',v_previous,
   'currentReviewStatus',v_cur_review,'previousReviewStatus',v_prev_review,
   'currentRecognitionPolicyVersion',v_cur_policy,'previousRecognitionPolicyVersion',v_prev_policy,
   'recognitionPolicyVersion',CASE WHEN v_cur_count=1 AND v_prev_count=1 AND
      v_cur_missing=0 AND v_prev_missing=0 AND v_cur_policy=v_prev_policy
      THEN v_cur_policy ELSE NULL END,
   'currency','ILS','periodTimeZone','Asia/Gaza','snapshotFingerprint',v_fingerprint,
   'generatedAt',statement_timestamp(),'sourceSnapshotAtomic',true,
   'accountingBasis','POSTED_GL_ACCRUAL','accountingCertification','NOT_CERTIFIED',
   'isFinalFinancialStatement',false,
   'status',CASE WHEN coalesce(array_length(v_blockers,1),0)=0
     THEN 'COMPARABLE_PRELIMINARY' ELSE 'BLOCKED' END,
   'canExport',coalesce(array_length(v_blockers,1),0)=0,
   'blockers',to_jsonb(v_blockers)
 );
END
$function$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_monthly_comparison(bigint,bigint,text,text)
 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_monthly_comparison(bigint,bigint,text,text)
 TO service_role;
