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
 IF (v_current->>'periodEnd')::date >= (statement_timestamp() AT TIME ZONE 'Asia/Gaza')::date
 THEN v_blockers:=array_append(v_blockers,'CURRENT_PERIOD_NOT_ENDED_GAZA');END IF;
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


-- C: bounded, single-query, multi-site GL series for authorized sites only.
-- No series is a consolidated or certified statement; no browser pagination.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_monthly_trend(
 p_tenant_id bigint,p_site_ids bigint[],p_end_period text,p_months integer DEFAULT 6
) RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path TO 'pg_catalog','public','pg_temp'
AS $function$
DECLARE
 v_start text;
 v_bad_count bigint;
 v_rows jsonb;
 v_site_count integer;
 v_tenant_name text;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0
    OR p_site_ids IS NULL OR coalesce(array_length(p_site_ids,1),0)<1
    OR array_length(p_site_ids,1)>30 OR array_position(p_site_ids,NULL) IS NOT NULL
    OR p_months IS NULL OR p_months<1 OR p_months>12
    OR p_end_period IS NULL OR p_end_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 THEN RAISE EXCEPTION 'GL_C_TREND_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_site_count FROM public.sites s
 WHERE s.tenant_id=p_tenant_id AND s.status='active' AND s.id=ANY(p_site_ids);
 IF v_site_count<>array_length(p_site_ids,1) OR
    (SELECT count(DISTINCT t.id) FROM unnest(p_site_ids) t(id))<>v_site_count
 THEN RAISE EXCEPTION 'GL_C_TREND_CROSS_TENANT_OR_DUPLICATE_SITE' USING ERRCODE='42501';END IF;
 SELECT name INTO STRICT v_tenant_name FROM public.tenants WHERE id=p_tenant_id;
 v_start:=to_char(((p_end_period||'-01')::date
   - make_interval(months => p_months-1))::date,'YYYY-MM');

 -- Fail closed on missing, unbalanced, malformed or foreign posted GL lines.
 WITH entry_checks AS (
   SELECT e.id,count(l.id) line_count,
    coalesce(sum(CASE WHEN l.side='debit' THEN l.amount
                      WHEN l.side='credit' THEN -l.amount ELSE 0 END),0) signed_net,
    count(*) FILTER (WHERE l.id IS NOT NULL AND
      (l.tenant_id<>e.tenant_id OR l.site_id<>e.site_id
       OR l.side NOT IN('credit','debit') OR l.amount<=0
       OR a.code IS NULL OR a.account_class NOT IN
        ('asset','liability','equity','revenue','expense')
       OR (a.account_class='revenue' AND a.code<>'4100')
       OR (a.account_class='expense' AND a.code NOT IN
        ('5100','5200','5300','5400','6100')))) invalid_lines
   FROM public.financial_gl_entries e
   LEFT JOIN public.financial_gl_lines l ON l.entry_id=e.id
   LEFT JOIN public.financial_gl_accounts a
      ON a.tenant_id=l.tenant_id AND a.code=l.account_code
   WHERE e.tenant_id=p_tenant_id AND e.site_id=ANY(p_site_ids)
     AND e.period BETWEEN v_start AND p_end_period
   GROUP BY e.id
 )
 SELECT count(*) INTO v_bad_count FROM entry_checks
 WHERE line_count<2 OR signed_net<>0 OR invalid_lines>0;
 IF v_bad_count>0 THEN
   RAISE EXCEPTION 'GL_C_TREND_UNBALANCED_OR_UNCLASSIFIED_SOURCE' USING ERRCODE='23514';
 END IF;

 WITH month_series AS (
    SELECT to_char(d::date,'YYYY-MM') period
    FROM generate_series((v_start||'-01')::date,
      (p_end_period||'-01')::date, interval '1 month') d
 ),
 sites_scope AS (
    SELECT s.id site_id,s.name site_name FROM public.sites s
    WHERE s.tenant_id=p_tenant_id AND s.id=ANY(p_site_ids) AND s.status='active'
 ),
 gl_monthly AS (
   SELECT e.site_id,e.period,count(DISTINCT e.id)::bigint entry_count,
     coalesce(sum(CASE WHEN a.account_class='revenue'
        THEN CASE WHEN l.side='credit' THEN l.amount ELSE -l.amount END
        ELSE 0 END),0) revenue,
     coalesce(sum(CASE WHEN a.code='5100'
        THEN CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END
        ELSE 0 END),0) direct_cost,
     coalesce(sum(CASE WHEN a.code='5200'
        THEN CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END
        ELSE 0 END),0) wages,
     coalesce(sum(CASE WHEN a.code='5300'
        THEN CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END
        ELSE 0 END),0) depreciation,
     coalesce(sum(CASE WHEN a.code='5400'
        THEN CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END
        ELSE 0 END),0) provisions,
     coalesce(sum(CASE WHEN a.code='6100'
        THEN CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END
        ELSE 0 END),0) nonoperating
   FROM public.financial_gl_entries e
   JOIN public.financial_gl_lines l
     ON l.entry_id=e.id AND l.tenant_id=e.tenant_id AND l.site_id=e.site_id
   JOIN public.financial_gl_accounts a
     ON a.tenant_id=e.tenant_id AND a.code=l.account_code
   WHERE e.tenant_id=p_tenant_id AND e.site_id=ANY(p_site_ids)
     AND e.period BETWEEN v_start AND p_end_period
   GROUP BY e.site_id,e.period
 ),
 policy AS (
   SELECT e.site_id,e.period,
      count(DISTINCT nullif(e.accounting_policy_version,'')) versions,
      count(*) FILTER(WHERE nullif(e.accounting_policy_version,'') IS NULL) missing,
      min(nullif(e.accounting_policy_version,'')) version
   FROM public.financial_gl_entries e
   WHERE e.tenant_id=p_tenant_id AND e.site_id=ANY(p_site_ids)
     AND e.period BETWEEN v_start AND p_end_period
     AND e.source_type='service_recognition'
   GROUP BY e.site_id,e.period
 ),
 full_rows AS (
   SELECT s.site_id,s.site_name,m.period,
     coalesce(g.entry_count,0)::bigint n,
     coalesce(g.revenue,0)::numeric revenue,
     coalesce(g.direct_cost,0)::numeric direct_cost,
     coalesce(g.wages,0)::numeric wages,
     coalesce(g.depreciation,0)::numeric depreciation,
     coalesce(g.provisions,0)::numeric provisions,
     coalesce(g.nonoperating,0)::numeric nonoperating,
     CASE WHEN p.versions=1 AND p.missing=0 THEN p.version ELSE null END version,
     CASE WHEN p.versions=1 AND p.missing=0 THEN 'SINGLE_VERSION'
          WHEN coalesce(p.versions,0)=0 THEN 'UNPROVEN'
          ELSE 'MIXED_POLICY' END policy_status
   FROM sites_scope s CROSS JOIN month_series m
   LEFT JOIN gl_monthly g ON g.site_id=s.site_id AND g.period=m.period
   LEFT JOIN policy p ON p.site_id=s.site_id AND p.period=m.period
 )
 SELECT jsonb_agg(jsonb_build_object(
   'siteId',site_id,'siteName',site_name,'period',period,'glEntryCount',n,
   'hasPostedData',n>0,'serviceRevenue',revenue,
   'directServiceCost',direct_cost,
   'grossResult',revenue-direct_cost,'wages',wages,
   'depreciation',depreciation,'provisions',provisions,
   'nonOperatingExpenses',nonoperating,
   'operatingResult',revenue-direct_cost-wages-depreciation-provisions,
   'provisionalNetResult',revenue-direct_cost-wages-depreciation-provisions-nonoperating,
   'recognitionPolicyVersion',version,'recognitionPolicyStatus',policy_status,
   'isFinalProfit',false,'isCompleteAccrualStatement',false
 ) ORDER BY site_id,period)
 INTO v_rows FROM full_rows;
 IF jsonb_array_length(coalesce(v_rows,'[]'::jsonb))<>v_site_count*p_months
 THEN RAISE EXCEPTION 'GL_C_TREND_RESULT_INCOMPLETE' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object(
   'tenantId',p_tenant_id,'tenantName',v_tenant_name,
   'siteIds',to_jsonb(p_site_ids),'siteCount',v_site_count,'months',p_months,
   'startPeriod',v_start,'endPeriod',p_end_period,'rows',v_rows,
   'source','POSTED_GL_FULL_PERIOD_AGGREGATES',
   'status','PRELIMINARY_GL_TREND_UNVERIFIED_SOURCES',
   'sourceCoverageVerified',false,'centralCostAllocationIncluded',false,
   'isConsolidatedFinancialStatement',false,'accountingCertification','NOT_CERTIFIED',
   'isFinalProfit',false,'generatedAt',statement_timestamp(),
   'periodTimeZone','Asia/Gaza','currency','ILS','sourceSnapshotAtomic',true);
END
$function$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_monthly_trend(bigint,bigint[],text,integer)
 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_monthly_trend(bigint,bigint[],text,integer)
 TO service_role;
