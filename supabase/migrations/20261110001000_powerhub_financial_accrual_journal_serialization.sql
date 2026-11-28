-- Complete journal serialization with period closing and strict retry payload checks.
-- Pairs with migration 20261110000000 to avoid row/advisory lock inversion.
CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_journal_create(
 p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_period text,
 p_debit_account text,p_credit_account text,p_amount numeric,
 p_reason text,p_operation_key text
) RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $create$
DECLARE v_id bigint; v_existing public.financial_accrual_journals%ROWTYPE;
BEGIN
 IF p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' OR
    p_tenant_id IS NULL OR p_site_id IS NULL OR p_user_id IS NULL OR
    p_amount IS NULL OR p_amount<=0 OR p_amount>100000000000 OR
    p_amount<>round(p_amount,2) OR
    length(trim(coalesce(p_reason,''))) NOT BETWEEN 10 AND 1000 OR
    length(trim(coalesce(p_operation_key,''))) NOT BETWEEN 8 AND 180 OR
    NOT EXISTS(SELECT 1 FROM public.sites WHERE id=p_site_id AND tenant_id=p_tenant_id AND status<>'archived') THEN
  RAISE EXCEPTION 'INVALID_ACCRUAL_JOURNAL' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
  'powerhub:accrual-period:'||p_tenant_id||':'||p_site_id||':'||p_period,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(
  p_tenant_id::text||':'||p_site_id::text||':'||p_operation_key,0));
 SELECT * INTO v_existing FROM public.financial_accrual_journals
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND operation_key=p_operation_key;
 IF FOUND THEN
   IF v_existing.period<>p_period OR v_existing.debit_account<>p_debit_account OR
      v_existing.credit_account<>p_credit_account OR v_existing.amount<>p_amount OR
      v_existing.reason<>p_reason OR v_existing.created_by_user_id<>p_user_id OR
      v_existing.reverses_journal_id IS NOT NULL THEN
     RAISE EXCEPTION 'ACCRUAL_OPERATION_KEY_CONFLICT' USING ERRCODE='23505';
   END IF;
   IF v_existing.status='void' THEN
     RAISE EXCEPTION 'ACCRUAL_OPERATION_ALREADY_VOID' USING ERRCODE='22023';
   END IF;
   RETURN v_existing.id;
 END IF;
 INSERT INTO public.financial_accrual_journals(
   tenant_id,site_id,period,debit_account,credit_account,amount,reason,operation_key,
   created_by_user_id
 ) VALUES(p_tenant_id,p_site_id,p_period,p_debit_account,p_credit_account,p_amount,
          trim(p_reason),p_operation_key,p_user_id)
 RETURNING id INTO v_id;
 RETURN v_id;
END;
$create$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_journal_post(
 p_tenant_id bigint,p_site_id bigint,p_journal_id bigint,p_user_id bigint
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $post$
DECLARE v_record public.financial_accrual_journals%ROWTYPE;
BEGIN
 -- Resolve the scope without a row lock, acquire period lock, then lock the row.
 SELECT * INTO v_record FROM public.financial_accrual_journals
 WHERE id=p_journal_id AND tenant_id=p_tenant_id AND site_id=p_site_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCRUAL_JOURNAL_OUT_OF_SCOPE' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
  'powerhub:accrual-period:'||p_tenant_id||':'||p_site_id||':'||v_record.period,0));
 SELECT * INTO v_record FROM public.financial_accrual_journals
 WHERE id=p_journal_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCRUAL_JOURNAL_OUT_OF_SCOPE' USING ERRCODE='22023'; END IF;
 IF v_record.status='posted' THEN
  IF v_record.approved_by_user_id=p_user_id THEN
    RETURN jsonb_build_object('id',v_record.id,'status','posted','alreadyPosted',true);
  END IF;
  RAISE EXCEPTION 'ACCRUAL_JOURNAL_ALREADY_POSTED' USING ERRCODE='22023';
 END IF;
 IF v_record.created_by_user_id=p_user_id OR p_user_id IS NULL THEN
  RAISE EXCEPTION 'ACCRUAL_SEPARATION_OF_DUTIES' USING ERRCODE='22023'; END IF;
 UPDATE public.financial_accrual_journals
 SET status='posted',approved_by_user_id=p_user_id,approved_at=now()
 WHERE id=p_journal_id;
 RETURN jsonb_build_object('id',p_journal_id,'status','posted','alreadyPosted',false);
END;
$post$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_journal_reverse(
 p_tenant_id bigint,p_site_id bigint,p_journal_id bigint,p_user_id bigint,
 p_period text,p_reason text,p_operation_key text
) RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $reverse$
DECLARE v_original public.financial_accrual_journals%ROWTYPE; v_id bigint;
BEGIN
 IF p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' OR
    length(trim(coalesce(p_reason,''))) NOT BETWEEN 10 AND 1000 OR
    length(trim(coalesce(p_operation_key,''))) NOT BETWEEN 8 AND 180 THEN
  RAISE EXCEPTION 'INVALID_ACCRUAL_REVERSAL' USING ERRCODE='22023'; END IF;
 -- Lock the destination period before locking the source journal, avoiding
 -- a row-lock -> advisory-lock inversion against month-end closing.
  PERFORM pg_advisory_xact_lock(hashtextextended(
  'powerhub:accrual-period:'||p_tenant_id||':'||p_site_id||':'||p_period,0));
 SELECT * INTO v_original FROM public.financial_accrual_journals
 WHERE id=p_journal_id AND tenant_id=p_tenant_id AND site_id=p_site_id
 FOR UPDATE;
 IF NOT FOUND OR v_original.status<>'posted' OR v_original.reverses_journal_id IS NOT NULL THEN
  RAISE EXCEPTION 'ACCRUAL_REVERSAL_SOURCE_INVALID' USING ERRCODE='22023'; END IF;
 IF p_period<v_original.period THEN
  RAISE EXCEPTION 'ACCRUAL_REVERSAL_PERIOD_INVALID' USING ERRCODE='22023'; END IF;
 SELECT id INTO v_id FROM public.financial_accrual_journals WHERE reverses_journal_id=p_journal_id;
 IF FOUND THEN
  IF EXISTS (SELECT 1 FROM public.financial_accrual_journals WHERE id=v_id
      AND operation_key=p_operation_key AND created_by_user_id=p_user_id AND period=p_period
      AND reason=trim(p_reason) AND status<>'void') THEN
   RETURN v_id; END IF;
  RAISE EXCEPTION 'ACCRUAL_REVERSAL_ALREADY_EXISTS' USING ERRCODE='23505';
 END IF;
 INSERT INTO public.financial_accrual_journals(
   tenant_id,site_id,period,debit_account,credit_account,amount,reason,operation_key,
   created_by_user_id,reverses_journal_id
 ) VALUES(p_tenant_id,p_site_id,p_period,v_original.credit_account,
   v_original.debit_account,v_original.amount,trim(p_reason),p_operation_key,p_user_id,p_journal_id)
 RETURNING id INTO v_id;
 RETURN v_id;
END;
$reverse$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_journal_void(
  p_tenant_id bigint,p_site_id bigint,p_journal_id bigint,p_user_id bigint,p_reason text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $void$
DECLARE v_record public.financial_accrual_journals%ROWTYPE;
BEGIN
 IF p_user_id IS NULL OR length(trim(coalesce(p_reason,''))) NOT BETWEEN 10 AND 1000 THEN
  RAISE EXCEPTION 'INVALID_ACCRUAL_VOID' USING ERRCODE='22023'; END IF;
 -- Resolve the scope without a row lock, acquire period lock, then lock the row.
 SELECT * INTO v_record FROM public.financial_accrual_journals
 WHERE id=p_journal_id AND tenant_id=p_tenant_id AND site_id=p_site_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCRUAL_JOURNAL_OUT_OF_SCOPE' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
  'powerhub:accrual-period:'||p_tenant_id||':'||p_site_id||':'||v_record.period,0));
 SELECT * INTO v_record FROM public.financial_accrual_journals
 WHERE id=p_journal_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCRUAL_JOURNAL_OUT_OF_SCOPE' USING ERRCODE='22023'; END IF;
 IF v_record.status='void' THEN
  IF v_record.voided_by_user_id=p_user_id AND v_record.void_reason=trim(p_reason) THEN
   RETURN jsonb_build_object('id',p_journal_id,'status','void','alreadyVoided',true); END IF;
  RAISE EXCEPTION 'ACCRUAL_JOURNAL_ALREADY_VOID' USING ERRCODE='22023';
 END IF;
 IF v_record.status<>'draft' THEN
  RAISE EXCEPTION 'ACCRUAL_POSTED_JOURNAL_REQUIRES_REVERSAL' USING ERRCODE='22023'; END IF;
 UPDATE public.financial_accrual_journals SET
  status='void',voided_by_user_id=p_user_id,voided_at=now(),void_reason=trim(p_reason)
 WHERE id=p_journal_id;
 RETURN jsonb_build_object('id',p_journal_id,'status','void','alreadyVoided',false);
END;
$void$;
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_journal_create(bigint,bigint,bigint,text,text,text,numeric,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_journal_post(bigint,bigint,bigint,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_journal_reverse(bigint,bigint,bigint,bigint,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_journal_void(bigint,bigint,bigint,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_journal_create(bigint,bigint,bigint,text,text,text,numeric,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_journal_post(bigint,bigint,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_journal_reverse(bigint,bigint,bigint,bigint,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_journal_void(bigint,bigint,bigint,bigint,text) TO service_role;
NOTIFY pgrst,'reload schema';
