-- B3.7 positive accounting-math proof only: synthetic two-site due-from/due-to journals,
-- verified arithmetic elimination and intact NOT_CERTIFIED. Full posting/review workflow is NOT implemented.
-- All temporary wallet-site mapping, movements and operation are rolled back.
BEGIN;
SET LOCAL statement_timeout='90000ms';
DO $proof$
DECLARE result jsonb; previous jsonb; before_gl bigint; before_lines bigint;
  v_from bigint;v_to bigint; v_due_asset numeric;v_due_liability numeric;
BEGIN
 SELECT count(*) INTO before_gl FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT count(*) INTO before_lines FROM public.financial_gl_lines WHERE tenant_id=1;
 IF before_gl<>25 OR before_lines<>51 THEN RAISE EXCEPTION 'B3_7_BASELINE_CHANGED'; END IF;
 previous:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
 INSERT INTO public.financial_gl_accounts(tenant_id,code,name,account_class,normal_side)
 VALUES(1,'1350','مستحق من فرع آخر','asset','debit'),
       (1,'2350','مستحق لفرع آخر','liability','credit');
 INSERT INTO public.company_account_sites(id,tenant_id,account_id,site_id)
 VALUES(900000000009123,1,6,9000000000099);
 INSERT INTO public.account_transactions
 (id,tenant_id,site_id,account_id,transaction_type,amount,description,reference_no,related_account_id,created_by_user_id,occurred_at)
 VALUES
 (900000000009123,1,1,5,'transfer_out',20,'B3 cross-site synthetic paired transfer','STG-B3.3-SOURCE-OUT',6,4,'2026-11-11T12:00:00+00'),
 (900000000009124,1,9000000000099,6,'transfer_in',20,'B3 cross-site synthetic paired transfer','STG-B3.3-SOURCE-IN',5,4,'2026-11-11T12:00:00+00');
 INSERT INTO public.company_account_movement_operations
 (tenant_id,operation_key,site_id,created_by_user_id,operation_type,payload_hash,primary_transaction_id,counterpart_transaction_id)
 VALUES(1,'2b41750f-c2da-4b45-b4a0-6a53d43698ef',1,4,'transfer',
 md5(jsonb_build_object('tenantId',1,'siteId',1,'userId',4,'fromAccountId',5,'toAccountId',6,'amount',20,'description','B3 cross-site synthetic paired transfer')::text),900000000009123,900000000009124);
 INSERT INTO public.financial_gl_entries(tenant_id,site_id,period,source_type,source_id,
  source_revision,operation_key,source_fingerprint,accounting_policy_version,posted_by_user_id)
 VALUES(1,1,'2026-11','account_movement','900000000009123',1,
  'gl:b37:inter-site:source:out',encode(digest('b37:out:900000000009123','sha256'),'hex'),
  'inter-site-due-from-synthetic-rollback-v1',4) RETURNING id INTO v_from;
 INSERT INTO public.financial_gl_lines(entry_id,tenant_id,site_id,account_code,side,amount)
 VALUES(v_from,1,1,'1350','debit',20),(v_from,1,1,'1010','credit',20);
 INSERT INTO public.financial_gl_entries(tenant_id,site_id,period,source_type,source_id,
  source_revision,operation_key,source_fingerprint,accounting_policy_version,posted_by_user_id)
 VALUES(1,9000000000099,'2026-11','account_movement','900000000009124',1,
  'gl:b37:inter-site:source:in',encode(digest('b37:in:900000000009124','sha256'),'hex'),
  'inter-site-due-to-synthetic-rollback-v1',4) RETURNING id INTO v_to;
 INSERT INTO public.financial_gl_lines(entry_id,tenant_id,site_id,account_code,side,amount)
 VALUES(v_to,1,9000000000099,'1020','debit',20),
       (v_to,1,9000000000099,'2350','credit',20);
 SELECT coalesce(sum(CASE WHEN side='debit' THEN amount ELSE -amount END),0)
 INTO v_due_asset FROM public.financial_gl_lines WHERE entry_id=v_from AND account_code='1350';
 SELECT coalesce(sum(CASE WHEN side='credit' THEN amount ELSE -amount END),0)
 INTO v_due_liability FROM public.financial_gl_lines WHERE entry_id=v_to AND account_code='2350';
 result:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
 IF (result->>'companyTransferSourceOperationCount')::bigint<>1
 OR (result->>'crossSiteOperationalTransferCount')::bigint<>1
 OR (result->>'crossSiteOperationalTransferAmount')::numeric<>20
 OR (result->>'invalidOperationalTransferPairCount')::bigint<>0
 OR result->>'interSiteSourceEvidenceStatus'<>'CROSS_SITE_TRANSFER_REQUIRES_GL_ELIMINATION_PROOF'
 OR (result->'readiness'->>'canBeCertifiedConsolidation')::boolean IS DISTINCT FROM false
 OR (result->>'isConsolidatedFinancialStatements')::boolean IS DISTINCT FROM false
 OR result->>'accountingCertification'<>'NOT_CERTIFIED'
 OR (result->'positionBeforeEliminations'->>'netAssets')::numeric
    <>(previous->'positionBeforeEliminations'->>'netAssets')::numeric+20
 OR (result->'positionBeforeEliminations'->>'liabilities')::numeric
    <>(previous->'positionBeforeEliminations'->>'liabilities')::numeric+20
 OR (result->'positionBeforeEliminations'->>'netAssets')::numeric-v_due_asset
    <>(previous->'positionBeforeEliminations'->>'netAssets')::numeric
 OR (result->'positionBeforeEliminations'->>'liabilities')::numeric-v_due_liability
    <>(previous->'positionBeforeEliminations'->>'liabilities')::numeric
 OR v_due_asset<>20 OR v_due_liability<>20
 OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>before_gl+2
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>before_lines+4
 THEN RAISE EXCEPTION 'B3_7_ELIMINATION_MATH_INTEGRITY_FAILED'; END IF;
END;$proof$;
SELECT 'B3_7_CROSS_SITE_DUE_FROM_TO_ELIMINATION_MATH_PASS_ROLLBACK' result;
ROLLBACK;
