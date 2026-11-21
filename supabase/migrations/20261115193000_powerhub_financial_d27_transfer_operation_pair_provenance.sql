-- D27: source-backed tenant cash transfer pair provenance; no writes or GL posting.
-- A matching transfer total does not establish pairing. Only an operation-key-
-- backed source transaction with its actual counterpart counts as verified.
CREATE OR REPLACE FUNCTION public.powerhub_financial_company_transfer_pair_provenance(
 p_tenant_id bigint,p_period text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path TO 'pg_catalog','public','pg_temp'
AS $fn$
DECLARE
 v_cutoff timestamptz;
 v_in_count bigint;v_out_count bigint;
 v_in_amount numeric;v_out_amount numeric;
 v_op_count bigint;v_valid bigint;v_distinct_sides bigint;v_invalid bigint;
 v_orphans bigint;v_total_transfer bigint;v_blockers jsonb:='[]'::jsonb;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<1
 OR p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 OR NOT EXISTS(SELECT 1 FROM public.sites s
   WHERE s.tenant_id=p_tenant_id AND s.status='active')
 THEN RAISE EXCEPTION 'GL_D27_INVALID_TENANT_OR_PERIOD'
 USING ERRCODE='22023';END IF;
 v_cutoff:=(((p_period||'-01')::date+interval '1 month')::timestamp
 AT TIME ZONE 'Asia/Gaza');

 SELECT count(*) FILTER(WHERE transaction_type='transfer_in'),
        count(*) FILTER(WHERE transaction_type='transfer_out'),
        coalesce(sum(amount) FILTER(WHERE transaction_type='transfer_in'),0),
        coalesce(sum(amount) FILTER(WHERE transaction_type='transfer_out'),0)
 INTO v_in_count,v_out_count,v_in_amount,v_out_amount
 FROM public.account_transactions t
 WHERE t.tenant_id=p_tenant_id AND t.occurred_at<v_cutoff
 AND t.transaction_type IN ('transfer_in','transfer_out');
 v_total_transfer:=v_in_count+v_out_count;

 -- Every operation must own EXACTLY two separately identified movements,
 -- both inside the requested period cut-off. Legacy transactions without
 -- operation provenance are explicitly unpaired, even when sums happen to
 -- match. Cross-site pairs are outside this intra-site proof's scope.
 WITH candidate AS (
  SELECT o.primary_transaction_id p_id,o.counterpart_transaction_id c_id,
   a.id a_id,b.id b_id,
   (a.id IS NOT NULL AND b.id IS NOT NULL
    AND a.id IS DISTINCT FROM b.id
    AND a.tenant_id=p_tenant_id AND b.tenant_id=p_tenant_id
    AND a.site_id=o.site_id AND b.site_id=o.site_id
    AND a.transaction_type='transfer_out' AND b.transaction_type='transfer_in'
    AND a.account_id IS DISTINCT FROM b.account_id
    AND a.related_account_id=b.account_id
    AND b.related_account_id=a.account_id
    AND a.amount IS NOT NULL AND a.amount>0 AND a.amount=round(a.amount,2)
    AND a.amount=b.amount
    AND a.created_by_user_id=o.created_by_user_id
    AND b.created_by_user_id=o.created_by_user_id
    AND ca.id IS NOT NULL AND cb.id IS NOT NULL
    AND a.occurred_at<v_cutoff AND b.occurred_at<v_cutoff
   ) verified
  FROM public.company_account_movement_operations o
  LEFT JOIN public.account_transactions a
    ON a.id=o.primary_transaction_id AND a.tenant_id=o.tenant_id
  LEFT JOIN public.account_transactions b
    ON b.id=o.counterpart_transaction_id AND b.tenant_id=o.tenant_id
  LEFT JOIN public.company_accounts ca
    ON ca.id=a.account_id AND ca.tenant_id=o.tenant_id
  LEFT JOIN public.company_accounts cb
    ON cb.id=b.account_id AND cb.tenant_id=o.tenant_id
  WHERE o.tenant_id=p_tenant_id AND o.operation_type='transfer'
   AND ((a.occurred_at<v_cutoff) OR (b.occurred_at<v_cutoff))
 ), valid_ops AS (
   SELECT p_id,c_id FROM candidate WHERE verified
 ), distinct_ids AS (
   SELECT p_id id FROM valid_ops
   UNION SELECT c_id id FROM valid_ops
 )
 SELECT
  (SELECT count(*) FROM candidate),
  (SELECT count(*) FROM valid_ops),
  (SELECT count(*) FROM distinct_ids)
 INTO v_op_count,v_valid,v_distinct_sides;
 v_invalid:=v_op_count-v_valid;
 v_orphans:=greatest(0,v_total_transfer-v_distinct_sides);

 IF v_in_count<>v_out_count OR v_in_amount<>v_out_amount THEN
  v_blockers:=v_blockers||'"TRANSFER_SIDES_UNBALANCED"'::jsonb;
 END IF;
 IF v_invalid>0 THEN
  v_blockers:=v_blockers||'"OPERATION_TRANSFER_PAIR_INVALID"'::jsonb;
 END IF;
 IF v_distinct_sides<>2*v_valid THEN
  v_blockers:=v_blockers||'"TRANSFER_MOVEMENT_REUSED_BY_MULTIPLE_OPERATIONS"'::jsonb;
 END IF;
 IF v_orphans>0 THEN
  v_blockers:=v_blockers||'"TRANSFER_MOVEMENT_WITHOUT_VERIFIED_OPERATION_PAIR"'::jsonb;
 END IF;
 -- A transfer with invalid/duplicate operation associations cannot become
 -- certified, even if each movement's sign and sum are numerically balanced.
 RETURN jsonb_build_object(
  'tenantId',p_tenant_id,'period',p_period,'asOfExclusive',v_cutoff,
  'status',CASE
    WHEN jsonb_array_length(v_blockers)>0 THEN 'BLOCKED_TRANSFER_PROVENANCE'
    WHEN v_total_transfer=0 THEN 'NO_TRANSFERS_PRELIMINARY'
    ELSE 'PRELIMINARY_SOURCE_BACKED_TRANSFER_PAIRS' END,
  'transferInCount',v_in_count,'transferOutCount',v_out_count,
  'transferInAmount',v_in_amount,'transferOutAmount',v_out_amount,
  'transferAmountDifference',v_in_amount-v_out_amount,
  'transferCountDifference',v_in_count-v_out_count,
  'transferMovementCount',v_total_transfer,
  'operationPairCount',v_op_count,'verifiedOperationPairCount',v_valid,
  'invalidOperationPairCount',v_invalid,
  'distinctVerifiedMovementCount',v_distinct_sides,
  'unverifiedTransferMovementCount',v_orphans,
  'blockers',v_blockers,
  'pairCoverageComplete',v_total_transfer>0
     AND v_invalid=0 AND v_orphans=0
     AND v_distinct_sides=2*v_valid,
  'glAndCashIndependentlyReconciled',false,
  'openingEvidenceApproved',false,
  'isConsolidatedFinancialStatements',false,
  'accountingCertification','NOT_CERTIFIED');
END $fn$;
REVOKE ALL ON FUNCTION public.powerhub_financial_company_transfer_pair_provenance(bigint,text)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_company_transfer_pair_provenance(bigint,text)
TO service_role;
COMMENT ON FUNCTION public.powerhub_financial_company_transfer_pair_provenance(bigint,text)
IS 'D27 intra-site operation-key based transfer source audit, preliminary only; not consolidated or certified.';
