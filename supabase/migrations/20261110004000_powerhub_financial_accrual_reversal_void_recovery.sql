-- Keep cancelled reversal drafts as audit history while permitting a fresh
-- active reversal. At most one non-void reversal per source journal.
ALTER TABLE public.financial_accrual_journals
 DROP CONSTRAINT IF EXISTS financial_accrual_journals_reverses_journal_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS financial_accrual_active_reversal_unique
 ON public.financial_accrual_journals(reverses_journal_id)
 WHERE reverses_journal_id IS NOT NULL AND status<>'void';

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
 SELECT id INTO v_id FROM public.financial_accrual_journals
 WHERE reverses_journal_id=p_journal_id AND status<>'void'
 ORDER BY id DESC LIMIT 1;
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
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_journal_reverse(bigint,bigint,bigint,bigint,text,text,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_journal_reverse(bigint,bigint,bigint,bigint,text,text,text)
 TO service_role;
NOTIFY pgrst,'reload schema';
