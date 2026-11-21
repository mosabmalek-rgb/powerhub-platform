-- Phase B1. Applied to Staging as 20261110180332.
-- GL-derived period income & cumulative site position.
-- Never claim certified profits or allocate shared cash to sites by inference.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_site_statements(p_tenant_id bigint, p_site_id bigint, p_period text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_accounts jsonb; v_count bigint;v_bad bigint;v_coverage jsonb;
 v_assets numeric;v_liabs numeric;v_equity numeric;v_revenue numeric;
 v_cost numeric;v_wages numeric;v_depreciation numeric;v_provisions numeric;
 v_nonoperating numeric;v_otheroperating numeric;v_retained numeric;
 v_debits numeric;v_credits numeric;v_unclassified bigint;
 v_profit numeric;v_equation numeric;v_first date;v_last date;
BEGIN
 IF p_tenant_id IS NULL OR p_site_id IS NULL OR p_period IS NULL
 OR p_tenant_id<=0 OR p_site_id<=0
 OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 OR NOT EXISTS(SELECT 1 FROM public.sites s WHERE s.tenant_id=p_tenant_id AND s.id=p_site_id AND s.status<>'archived')
 THEN RAISE EXCEPTION 'GL_B1_INVALID_SCOPE' USING ERRCODE='22023';END IF;
 v_first:=(p_period||'-01')::date;
 v_last:=(v_first+interval '1 month'-interval '1 day')::date;
 SELECT count(*) INTO v_count FROM public.financial_gl_entries e
 WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id AND e.period<=p_period;
 SELECT count(*) INTO v_bad FROM (
  SELECT e.id,count(l.id) n,
  coalesce(sum(CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END),0) net
  FROM public.financial_gl_entries e LEFT JOIN public.financial_gl_lines l
    ON l.entry_id=e.id AND l.tenant_id=e.tenant_id AND l.site_id=e.site_id
  WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id AND e.period<=p_period
  GROUP BY e.id
 ) x WHERE x.n<2 OR x.net<>0;
 IF v_bad>0 THEN RAISE EXCEPTION 'GL_B1_INVALID_POSTED_ENTRIES' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO v_bad FROM public.financial_gl_entries e JOIN public.financial_gl_lines l ON l.entry_id=e.id
 LEFT JOIN public.financial_gl_accounts a ON a.tenant_id=l.tenant_id AND a.code=l.account_code
 WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id AND e.period<=p_period
 AND (l.tenant_id<>e.tenant_id OR l.site_id<>e.site_id OR a.code IS NULL
 OR a.account_class NOT IN ('asset','liability','equity','revenue','expense')
 OR l.side NOT IN('debit','credit') OR l.amount<=0);
 IF v_bad>0 THEN RAISE EXCEPTION 'GL_B1_UNCLASSIFIED_OR_FOREIGN_LINES' USING ERRCODE='23514';END IF;
 WITH account_totals AS (
 SELECT a.code,a.name,a.account_class,a.is_contra,
 sum(CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END) signed_asof,
 sum(CASE WHEN e.period=p_period THEN (CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END) ELSE 0 END) signed_period,
 sum(CASE WHEN l.side='debit' THEN l.amount ELSE 0 END) dr,
 sum(CASE WHEN l.side='credit' THEN l.amount ELSE 0 END) cr
 FROM public.financial_gl_entries e
 JOIN public.financial_gl_lines l ON l.entry_id=e.id AND l.tenant_id=e.tenant_id AND l.site_id=e.site_id
 JOIN public.financial_gl_accounts a ON a.tenant_id=l.tenant_id AND a.code=l.account_code
 WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id AND e.period<=p_period
 GROUP BY a.code,a.name,a.account_class,a.is_contra
 ), values_by_account AS (
 SELECT *,
 CASE WHEN account_class IN('asset','expense') THEN signed_asof ELSE -signed_asof END asof_balance,
 CASE WHEN account_class IN('asset','expense') THEN signed_period ELSE -signed_period END period_balance
 FROM account_totals
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'code',code,'name',name,'class',account_class,'isContra',is_contra,
   'closingBalance',asof_balance,'periodBalance',period_balance,'debitTurnover',dr,'creditTurnover',cr)
   ORDER BY code),'[]'::jsonb),
 coalesce(sum(CASE WHEN account_class='asset' THEN asof_balance ELSE 0 END),0),
 coalesce(sum(CASE WHEN account_class='liability' THEN asof_balance ELSE 0 END),0),
 coalesce(sum(CASE WHEN account_class='equity' THEN asof_balance ELSE 0 END),0),
 coalesce(sum(CASE WHEN account_class='revenue' THEN period_balance ELSE 0 END),0),
 coalesce(sum(CASE WHEN code='5100' THEN period_balance ELSE 0 END),0),
 coalesce(sum(CASE WHEN code='5200' THEN period_balance ELSE 0 END),0),
 coalesce(sum(CASE WHEN code='5300' THEN period_balance ELSE 0 END),0),
 coalesce(sum(CASE WHEN code='5400' THEN period_balance ELSE 0 END),0),
 coalesce(sum(CASE WHEN code='6100' THEN period_balance ELSE 0 END),0),
 coalesce(sum(CASE WHEN account_class='expense' AND code NOT IN('5100','5200','5300','5400','6100')
 THEN period_balance ELSE 0 END),0),
 coalesce(sum(CASE WHEN account_class='revenue' THEN asof_balance
 WHEN account_class='expense' THEN -asof_balance ELSE 0 END),0),
 coalesce(sum(dr),0),coalesce(sum(cr),0),
 count(*) FILTER(WHERE (account_class='revenue' AND code<>'4100')
 OR (account_class='expense' AND code NOT IN('5100','5200','5300','5400','6100')))
 INTO v_accounts,v_assets,v_liabs,v_equity,v_revenue,v_cost,v_wages,
 v_depreciation,v_provisions,v_nonoperating,v_otheroperating,v_retained,
 v_debits,v_credits,v_unclassified FROM values_by_account;
 v_profit:=v_revenue-v_cost-v_wages-v_depreciation-v_provisions-v_otheroperating-v_nonoperating;
 v_equation:=v_assets-v_liabs-v_equity-v_retained;
 IF v_unclassified>0 THEN
 RAISE EXCEPTION 'GL_B1_UNMAPPED_INCOME_OR_EXPENSE' USING ERRCODE='23514';END IF;
 IF v_debits<>v_credits OR v_equation<>0
 THEN RAISE EXCEPTION 'GL_B1_FINANCIAL_EQUATION_UNBALANCED' USING ERRCODE='23514';END IF;
 v_coverage:=public.powerhub_financial_gl_source_coverage(p_tenant_id,p_site_id,p_period);
 IF v_coverage->>'accountingCertification'<>'NOT_CERTIFIED'
 OR (v_coverage->>'tenantId')::bigint IS DISTINCT FROM p_tenant_id
 OR (v_coverage->>'siteId')::bigint IS DISTINCT FROM p_site_id
 THEN RAISE EXCEPTION 'GL_B1_COVERAGE_SCOPE_INVALID' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('tenantId',p_tenant_id,'siteId',p_site_id,
 'period',p_period,'periodStart',v_first,'periodEnd',v_last,
 'glEntryCount',v_count,'hasPostedData',v_count>0,'accounts',v_accounts,
 'siteScope','SITE_ONLY','accountingBasis','POSTED_GL_ACCRUAL',
 'accountingCertification','NOT_CERTIFIED','isFinalProfit',false,
 'isCompleteAccrualStatement',false,'isFinalBalanceSheet',false,
 'isMathematicallyBalanced',true,'unclassifiedAccountCount',v_unclassified,
 'unreconciledSourceCount',v_coverage->'unreconciledSourceCount',
 'isSourceCoverageComplete',v_coverage->'isSourceCoverageComplete',
 'incomeStatement',jsonb_build_object(
  'serviceRevenue',v_revenue,'directServiceCost',v_cost,'grossResult',v_revenue-v_cost,
  'wages',v_wages,'depreciation',v_depreciation,'provisions',v_provisions,
  'otherOperatingExpenses',v_otheroperating,
  'operatingResult',v_profit+v_nonoperating,'nonOperatingExpenses',v_nonoperating,
  'taxExpense','null'::jsonb,'taxExpenseStatus','NOT_MAPPED_IN_GL_CHART',
  'provisionalNetResult',v_profit,'isFinalProfit',false),
 'balanceSheet',jsonb_build_object(
  'asOfDate',v_last,'netAssets',v_assets,'liabilities',v_liabs,
  'postedEquity',v_equity,'unclosedAccumulatedResult',v_retained,
  'equityIncludingUnclosedResult',v_equity+v_retained,
  'equationDifference',v_equation,'isFinalBalanceSheet',false),
 'branchProfitability',jsonb_build_object(
  'directGrossResult',v_revenue-v_cost,
  'siteResultBeforeCentralAllocation',v_profit,
  'centralCostAllocationStatus','NOT_CONFIGURED_OR_APPROVED',
  'allocatedCentralExpenses','null'::jsonb,
  'unallocatedCentralExpenses','null'::jsonb,'isFinalBranchProfit',false),
 'consolidation',jsonb_build_object(
  'status','NOT_CONSOLIDATED','companyAccountsIncluded',false,
  'sharedCompanyAccountDoubleCountAvoidedByOmission',true));
END;$function$
;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_site_statements(bigint,bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_site_statements(bigint,bigint,text) TO service_role;
