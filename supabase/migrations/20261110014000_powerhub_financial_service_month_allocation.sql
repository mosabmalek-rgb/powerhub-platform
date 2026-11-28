-- Phase A1: invoice-backed monthly service allocation using Gaza calendar
-- days and integer minor units. Supporting schedule only: no unbilled service
-- estimates or accounting GL postings, and NEVER a certified earned-revenue flag.
CREATE OR REPLACE FUNCTION public.powerhub_financial_service_month_allocation(
 p_tenant_id bigint,p_site_id bigint,p_period text,p_as_of timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $allocation$
DECLARE v_first date;v_last date;v_as_of_date date;
 v_lower timestamptz;v_upper timestamptz;
 v_missing bigint;v_invalid bigint;v_eligible bigint;
 v_cross_month bigint;v_allocated bigint;v_billed bigint;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
    OR p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    OR p_as_of IS NULL OR NOT EXISTS(
      SELECT 1 FROM public.sites s WHERE s.id=p_site_id AND s.tenant_id=p_tenant_id
        AND s.status<>'archived')
 THEN RAISE EXCEPTION 'SERVICE_ALLOCATION_INVALID_SCOPE' USING ERRCODE='22023'; END IF;
 v_first:=(p_period||'-01')::date;
 v_last:=(v_first+INTERVAL '1 month - 1 day')::date;
 v_as_of_date:=(p_as_of AT TIME ZONE 'Asia/Gaza')::date;
 v_lower:=(v_first::timestamp AT TIME ZONE 'Asia/Gaza');
 v_upper:=((v_last+1)::timestamp AT TIME ZONE 'Asia/Gaza');
 SELECT count(*) INTO v_missing
 FROM public.invoices i
 WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id
   AND i.status IN ('issued','overdue','partially_paid','paid')
   AND (i.cycle_start_at IS NULL OR i.cycle_end_at IS NULL)
   AND i.issue_date>=v_lower AND i.issue_date<v_upper;
 WITH scoped AS (
   SELECT i.id,i.total_amount,i.tax_amount,i.cycle_start_at,i.cycle_end_at,
      (i.cycle_start_at AT TIME ZONE 'Asia/Gaza')::date AS first_day,
      (i.cycle_end_at AT TIME ZONE 'Asia/Gaza')::date AS last_day
   FROM public.invoices i
   WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id
     AND i.status IN ('issued','overdue','partially_paid','paid')
     AND i.cycle_start_at IS NOT NULL AND i.cycle_end_at IS NOT NULL
     AND i.cycle_end_at>=v_lower-INTERVAL '2 days'
     AND i.cycle_start_at<v_upper+INTERVAL '2 days'
 ), filtered AS (
   SELECT *,last_day-first_day+1 AS days,
     LEAST(last_day,v_last,v_as_of_date) AS recognized_through,
     GREATEST(first_day,v_first) AS month_from
   FROM scoped
   WHERE last_day>=v_first AND first_day<=v_last
 ), eligible AS (
   SELECT *,((total_amount-tax_amount)*100)::bigint AS net_cents
   FROM filtered
   WHERE cycle_start_at<=cycle_end_at
     AND total_amount IS NOT NULL AND tax_amount IS NOT NULL
     AND total_amount>=0 AND tax_amount>=0 AND tax_amount<=total_amount
     AND total_amount=round(total_amount,2) AND tax_amount=round(tax_amount,2)
     AND days BETWEEN 1 AND 3660
 ), portions AS (
   SELECT *,
     CASE WHEN recognized_through<month_from THEN 0::bigint ELSE
       (net_cents*((recognized_through-first_day+1)::bigint)/days::bigint)
       -(net_cents*((month_from-first_day)::bigint)/days::bigint)
     END AS allocated_cents
   FROM eligible
 )
 SELECT (SELECT count(*) FROM filtered)-
        (SELECT count(*) FROM eligible),
        (SELECT count(*) FROM eligible),
        (SELECT count(*) FROM eligible WHERE first_day<v_first OR last_day>v_last),
        COALESCE(sum(allocated_cents),0),
        COALESCE(sum(net_cents),0)
 INTO v_invalid,v_eligible,v_cross_month,v_allocated,v_billed
 FROM portions;
 IF v_invalid>0 THEN
   RAISE EXCEPTION 'SERVICE_ALLOCATION_SOURCE_INVALID' USING ERRCODE='22023'; END IF;
 IF v_missing>0 THEN
   RAISE EXCEPTION 'SERVICE_ALLOCATION_CYCLE_MISSING' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object(
  'tenantId',p_tenant_id,'siteId',p_site_id,'period',p_period,'asOf',p_as_of,
  'recognitionPolicyVersion','gaza-invoice-service-calendar-days-v1',
  'invoiceCount',v_eligible,'crossMonthCount',v_cross_month,
  'missingCycleCount',v_missing,'invalidInvoiceCount',v_invalid,
  'monthlyServiceAllocationExTaxMinor',v_allocated,
  'intersectingInvoiceBilledExTaxMinor',v_billed,
  'isBilledServiceAllocation',true,'isEarnedRevenueCertified',false,
  'isUnbilledServiceComplete',false,'isCompleteAccrualStatement',false,
  'accountingCertification','NOT_CERTIFIED');
END;
$allocation$;
REVOKE ALL ON FUNCTION public.powerhub_financial_service_month_allocation(bigint,bigint,text,timestamptz)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_service_month_allocation(bigint,bigint,text,timestamptz)
 TO service_role;
NOTIFY pgrst,'reload schema';
