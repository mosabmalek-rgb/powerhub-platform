-- Phase A4: cumulative, site-scoped GL trial balance, derived only from
-- posted GL lines. This reports mathematical balance and source completeness
-- separately, and never calls a partial ledger a certified balance sheet.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_trial_balance(
 p_tenant_id bigint,p_site_id bigint,p_period text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $trial$
DECLARE v_coverage jsonb;v_total_debits numeric;v_total_credits numeric;
 v_debit_balances numeric;v_credit_balances numeric;
 v_account_count bigint;v_entry_count bigint;v_lines jsonb;
BEGIN
 v_coverage:=public.powerhub_financial_gl_source_coverage(
   p_tenant_id,p_site_id,p_period);
 WITH scoped AS (
   SELECT e.id,l.account_code,a.name,a.account_class,a.normal_side,a.is_contra,
          l.side,l.amount
   FROM public.financial_gl_entries e
   JOIN public.financial_gl_lines l ON l.entry_id=e.id
     AND l.tenant_id=e.tenant_id AND l.site_id=e.site_id
   JOIN public.financial_gl_accounts a ON a.tenant_id=l.tenant_id
     AND a.code=l.account_code
   WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
      AND e.period<=p_period
 ), balances AS (
   SELECT s.account_code,max(s.name) AS name,max(s.account_class) AS class,
     max(s.normal_side) AS normal_side,
     bool_or(s.is_contra) AS is_contra,
     coalesce(sum(s.amount) FILTER(WHERE s.side='debit'),0) AS debit_turnover,
     coalesce(sum(s.amount) FILTER(WHERE s.side='credit'),0) AS credit_turnover
   FROM scoped s GROUP BY s.account_code
 ), report AS (
   SELECT b.*,
     greatest(b.debit_turnover-b.credit_turnover,0) AS debit_balance,
     greatest(b.credit_turnover-b.debit_turnover,0) AS credit_balance
   FROM balances b
 )
 SELECT coalesce(sum(debit_turnover),0),
        coalesce(sum(credit_turnover),0),
        coalesce(sum(debit_balance),0),
        coalesce(sum(credit_balance),0),count(*)
 INTO v_total_debits,v_total_credits,v_debit_balances,v_credit_balances,v_account_count
 FROM report;
 IF v_account_count>2500 THEN
   RAISE EXCEPTION 'GL_TRIAL_TOO_MANY_ACCOUNTS' USING ERRCODE='54000';
 END IF;
 SELECT count(*) INTO v_entry_count FROM public.financial_gl_entries e
 WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id AND e.period<=p_period;
 WITH balances AS (
   SELECT a.code,a.name,a.account_class,a.normal_side,a.is_contra,
     coalesce(sum(l.amount) FILTER(WHERE l.side='debit'),0) AS debit_turnover,
     coalesce(sum(l.amount) FILTER(WHERE l.side='credit'),0) AS credit_turnover
   FROM public.financial_gl_entries e JOIN public.financial_gl_lines l
     ON l.entry_id=e.id AND l.tenant_id=e.tenant_id AND l.site_id=e.site_id
   JOIN public.financial_gl_accounts a ON a.tenant_id=l.tenant_id
     AND a.code=l.account_code
   WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id AND e.period<=p_period
   GROUP BY a.code,a.name,a.account_class,a.normal_side,a.is_contra
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'code',code,'name',name,'class',account_class,'normalSide',normal_side,
   'isContra',is_contra,'debitTurnover',debit_turnover,
   'creditTurnover',credit_turnover,
   'debitBalance',greatest(debit_turnover-credit_turnover,0),
   'creditBalance',greatest(credit_turnover-debit_turnover,0))
   ORDER BY code),'[]'::jsonb)
 INTO v_lines FROM balances;
 IF v_total_debits<>v_total_credits OR v_debit_balances<>v_credit_balances THEN
   RAISE EXCEPTION 'GL_TRIAL_BALANCE_MISMATCH' USING ERRCODE='23514';
 END IF;
 RETURN jsonb_build_object(
   'tenantId',p_tenant_id,'siteId',p_site_id,'throughPeriod',p_period,
   'postedEntryCount',v_entry_count,'accountCount',v_account_count,
   'debitTurnover',v_total_debits,'creditTurnover',v_total_credits,
   'debitBalances',v_debit_balances,'creditBalances',v_credit_balances,
   'difference',v_debit_balances-v_credit_balances,
   'isMathematicallyBalanced',true,
   'isSourceCoverageComplete',v_coverage->'isSourceCoverageComplete',
   'sourceCoverage',v_coverage,'accounts',v_lines,
   'isCompleteAccrualStatement',false,'isFinalBalanceSheet',false,
   'accountingCertification','NOT_CERTIFIED');
END;
$trial$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_trial_balance(bigint,bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_trial_balance(bigint,bigint,text)
 TO service_role;
NOTIFY pgrst,'reload schema';
