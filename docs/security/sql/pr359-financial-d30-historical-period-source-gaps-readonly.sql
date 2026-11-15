-- D30 historical source-coverage inventory for technical tenant.
-- READ ONLY; aggregate evidence, not historical source attestation or cash/GL certification.
BEGIN READ ONLY;
SET LOCAL statement_timeout='120000ms';
DO $proof$
DECLARE n bigint; u bigint; tr bigint; ops bigint; gl bigint; diff numeric; months bigint;
BEGIN
 WITH scope AS (
 SELECT t.*,to_char(t.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM') AS local_period
 FROM public.account_transactions t
 WHERE t.tenant_id=9000000000001
 AND t.occurred_at<('2026-11-01'::timestamp AT TIME ZONE 'Asia/Gaza')
 )
 SELECT count(*),
 count(*) FILTER (WHERE transaction_type NOT IN ('transfer_in','transfer_out')
 AND related_payment_id IS NULL AND related_expense_id IS NULL
 AND related_supplier_payment_id IS NULL AND related_supplier_return_id IS NULL
 AND related_account_id IS NULL),
 count(*) FILTER (WHERE transaction_type IN ('transfer_in','transfer_out')),
 coalesce(sum(amount) FILTER(WHERE transaction_type='transfer_in'),0)
 -coalesce(sum(amount) FILTER(WHERE transaction_type='transfer_out'),0),
 count(distinct local_period)
 INTO n,u,tr,diff,months FROM scope;
 SELECT count(*) INTO ops FROM public.company_account_movement_operations
 WHERE tenant_id=9000000000001;
 SELECT count(*) INTO gl FROM public.financial_gl_entries
 WHERE tenant_id=9000000000001 AND period<='2026-10';
 IF n<>105544 OR u<>84434 OR tr<>21110 OR diff<>10555
 OR ops<>0 OR gl<>0 OR months<>3
 THEN RAISE EXCEPTION 'D30_HISTORICAL_SOURCE_INVENTORY_DRIFT';END IF;
 IF EXISTS (
  WITH monthly AS (
   SELECT to_char(occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM') period,
    count(*) n,
    count(*) FILTER(WHERE transaction_type IN ('transfer_in','transfer_out')) transfers,
    coalesce(sum(amount) FILTER(WHERE transaction_type='transfer_in'),0)
     -coalesce(sum(amount) FILTER(WHERE transaction_type='transfer_out'),0) difference,
    count(*) FILTER(WHERE related_payment_id IS NOT NULL
       OR related_expense_id IS NOT NULL OR related_supplier_payment_id IS NOT NULL
       OR related_supplier_return_id IS NOT NULL OR related_account_id IS NOT NULL) links
   FROM public.account_transactions
   WHERE tenant_id=9000000000001 AND occurred_at<
    ('2026-11-01'::timestamp AT TIME ZONE 'Asia/Gaza')
   GROUP BY 1
  ), expected(period,n,transfers,difference) AS (
   VALUES ('2026-08',30139::bigint,6030::bigint,3015::numeric),
          ('2026-09',37191::bigint,7438::bigint,3719::numeric),
          ('2026-10',38214::bigint,7642::bigint,3821::numeric)
  )
  SELECT 1 FROM monthly m FULL JOIN expected e USING(period)
  WHERE m.n IS DISTINCT FROM e.n
  OR m.transfers IS DISTINCT FROM e.transfers
  OR m.difference IS DISTINCT FROM e.difference
  OR m.links IS DISTINCT FROM 0
 ) THEN RAISE EXCEPTION 'D30_MONTHLY_TRANSFER_OR_SOURCE_BOUNDARY_DRIFT'; END IF;
 IF (SELECT count(*) FROM public.financial_gl_entries)<>25
 OR (SELECT count(*) FROM public.financial_gl_lines)<>51
 OR (SELECT count(*) FROM public.account_transactions)<>361009
 THEN RAISE EXCEPTION 'D30_FINANCIAL_BASELINE_DRIFT';END IF;
END $proof$;
SELECT 'D30_STAGING_HISTORICAL_PERIOD_SOURCE_GAP_INVENTORY_SCOPED_PASS' AS result;
ROLLBACK;