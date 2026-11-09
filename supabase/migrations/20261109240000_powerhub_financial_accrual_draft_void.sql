-- Draft corrections must be auditable voids, not deletes or mutations.
ALTER TABLE public.financial_accrual_journals
  DROP CONSTRAINT financial_accrual_journals_status_check;
ALTER TABLE public.financial_accrual_journals
  ADD CONSTRAINT financial_accrual_journals_status_check
  CHECK(status IN ('draft','posted','void'));
ALTER TABLE public.financial_accrual_journals
  ADD COLUMN IF NOT EXISTS voided_by_user_id bigint REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS void_reason text;
ALTER TABLE public.financial_accrual_journals
  ADD CONSTRAINT financial_accrual_journal_void_consistency
  CHECK(
    (status='void' AND voided_by_user_id IS NOT NULL AND voided_at IS NOT NULL
      AND length(trim(void_reason)) BETWEEN 10 AND 1000) OR
    (status<>'void' AND voided_by_user_id IS NULL AND voided_at IS NULL AND void_reason IS NULL)
  );
CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_journal_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $guard$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'ACCRUAL_JOURNAL_DELETE_DENIED' USING ERRCODE='22023';
 ELSIF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' OR NEW.approved_by_user_id IS NOT NULL OR
      NEW.approved_at IS NOT NULL OR NEW.created_by_user_id IS NULL
     OR NEW.voided_by_user_id IS NOT NULL OR NEW.voided_at IS NOT NULL
     OR NEW.void_reason IS NOT NULL THEN
   RAISE EXCEPTION 'ACCRUAL_JOURNAL_MUST_START_DRAFT' USING ERRCODE='22023';
  END IF;
 ELSIF TG_OP='UPDATE' THEN
  IF OLD.status<>'draft'
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.site_id IS DISTINCT FROM OLD.site_id
    OR NEW.period IS DISTINCT FROM OLD.period
    OR NEW.debit_account IS DISTINCT FROM OLD.debit_account
    OR NEW.credit_account IS DISTINCT FROM OLD.credit_account
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.reverses_journal_id IS DISTINCT FROM OLD.reverses_journal_id
    OR NEW.approved_by_user_id IS NULL
    OR NEW.approved_by_user_id=NEW.created_by_user_id
    OR (NEW.status='posted' AND
      (NEW.approved_by_user_id IS NULL OR NEW.approved_by_user_id=NEW.created_by_user_id
        OR NEW.approved_at IS NULL OR NEW.voided_by_user_id IS NOT NULL OR NEW.voided_at IS NOT NULL
        OR NEW.void_reason IS NOT NULL)) OR
    (NEW.status='void' AND
      (NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL
        OR NEW.voided_by_user_id IS NULL OR NEW.voided_at IS NULL
        OR length(trim(coalesce(NEW.void_reason,'')))<10)) OR
    NEW.status NOT IN ('posted','void') THEN
   RAISE EXCEPTION 'ACCRUAL_JOURNAL_IMMUTABLE' USING ERRCODE='22023';
  END IF;
 END IF;
 RETURN NEW;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_journal_void(
  p_tenant_id bigint,p_site_id bigint,p_journal_id bigint,p_user_id bigint,p_reason text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $void$
DECLARE v_record public.financial_accrual_journals%ROWTYPE;
BEGIN
 IF p_user_id IS NULL OR length(trim(coalesce(p_reason,''))) NOT BETWEEN 10 AND 1000 THEN
  RAISE EXCEPTION 'INVALID_ACCRUAL_VOID' USING ERRCODE='22023'; END IF;
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
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_journal_void(bigint,bigint,bigint,bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_journal_void(bigint,bigint,bigint,bigint,text)
 TO service_role;
