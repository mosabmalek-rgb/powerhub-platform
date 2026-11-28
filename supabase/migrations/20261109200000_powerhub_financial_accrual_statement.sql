-- Provisional monthly accrual statement, recomputed from authoritative sources
-- plus separately approved, immutable balanced adjustment journals.
CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_month_statement(
 p_tenant_id bigint,p_site_id bigint,p_period text,p_as_of timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $statement$
DECLARE
 v_base jsonb;
 v_journal jsonb;
 v_revenue numeric;
 v_operating numeric;
 v_nonoperating numeric;
 v_provisional numeric;
BEGIN
 v_base := public.powerhub_financial_accrual_month_review(
   p_tenant_id,p_site_id,p_period,p_as_of
 );
 WITH posted AS (
   SELECT debit_account,credit_account,amount,reverses_journal_id
   FROM public.financial_accrual_journals
   WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND period=p_period AND status='posted'
 ), totals AS (
   SELECT
    COALESCE(SUM(CASE WHEN credit_account='4100' THEN amount
      WHEN debit_account='4100' THEN -amount ELSE 0 END),0) AS revenue,
    COALESCE(SUM(CASE WHEN debit_account IN ('5100','5300','5400') THEN amount
      WHEN credit_account IN ('5100','5300','5400') THEN -amount ELSE 0 END),0) AS operating,
    COALESCE(SUM(CASE WHEN debit_account='6100' THEN amount
      WHEN credit_account='6100' THEN -amount ELSE 0 END),0) AS nonoperating,
    COUNT(*) AS posted_count,
    COUNT(*) FILTER(WHERE reverses_journal_id IS NOT NULL) AS reversal_count
   FROM posted
 )
 SELECT jsonb_build_object(
   'revenue',revenue,'operating',operating,'nonoperating',nonoperating,
   'postedCount',posted_count,'reversalCount',reversal_count,
   'draftCount',(SELECT COUNT(*) FROM public.financial_accrual_journals
      WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND period=p_period AND status='draft'),
   'balancedDebits',COALESCE((SELECT SUM(amount) FROM posted),0),
   'balancedCredits',COALESCE((SELECT SUM(amount) FROM posted),0)
 ) INTO v_journal FROM totals;
 v_revenue:=(v_journal->>'revenue')::numeric;
 v_operating:=(v_journal->>'operating')::numeric;
 v_nonoperating:=(v_journal->>'nonoperating')::numeric;
 v_provisional:=(v_base->>'provisionalNetBeforePeriodAdjustments')::numeric
   +v_revenue-v_operating-v_nonoperating;
 RETURN v_base||jsonb_build_object(
   'journalAdjustments',v_journal,
   'revenueAfterAdjustments',(v_base->>'serviceBillingExTax')::numeric+v_revenue,
   'operatingCostsAfterAdjustments',
     (v_base->>'operatingDirectExpenses')::numeric+
     (v_base->>'payrollGrossCost')::numeric+
     (v_base->>'inventoryConsumptionCost')::numeric+v_operating,
   'nonOperatingCostsAfterAdjustments',
     (v_base->>'nonOperatingDirectExpenses')::numeric+v_nonoperating,
   'provisionalNetAfterAdjustments',v_provisional,
   'isFinalProfit',false,
   'isCompleteAccrualStatement',false,
   'recognitionPolicy','completed_service_cycle_plus_approved_adjustments',
   'limitations',
    jsonb_build_array(
      'Unbilled service not independently reconciled',
      'Only approved balanced journals affect provisional values',
      'Missing cut-off attestations, opening balances and full general-ledger reconciliation',
      'Depreciation, provisions and other accruals require manual posted journal adjustments'
    )
 );
END;
$statement$;
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_month_statement(bigint,bigint,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_month_statement(bigint,bigint,text,timestamptz) TO service_role;
COMMENT ON FUNCTION public.powerhub_financial_accrual_month_statement(bigint,bigint,text,timestamptz)
 IS 'Monthly accrual source plus immutable approved adjusting subledger. Provisional, not certified P&L.';
NOTIFY pgrst,'reload schema';
