-- An append-only, balanced adjustment sub-ledger. Does not mutate legacy cash settlements.
CREATE TABLE IF NOT EXISTS public.financial_accrual_journals (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id bigint NOT NULL REFERENCES public.tenants(id),
 site_id bigint NOT NULL REFERENCES public.sites(id),
 period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 debit_account text NOT NULL,
 credit_account text NOT NULL,
 amount numeric(18,2) NOT NULL CHECK (amount>0),
 reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 1000),
 operation_key text NOT NULL CHECK(length(trim(operation_key)) BETWEEN 8 AND 180),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted')),
 created_by_user_id bigint NOT NULL REFERENCES public.users(id),
 approved_by_user_id bigint REFERENCES public.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 approved_at timestamptz,
 reverses_journal_id bigint UNIQUE REFERENCES public.financial_accrual_journals(id),
 CONSTRAINT financial_accrual_journals_operation_unique UNIQUE(tenant_id,site_id,operation_key),
 CONSTRAINT financial_accrual_journals_accounts_check CHECK(
  (debit_account='1100' AND credit_account='4100') OR
  (debit_account='4100' AND credit_account='1100') OR
  (debit_account='2200' AND credit_account='4100') OR
  (debit_account='4100' AND credit_account='2200') OR
  (debit_account='5100' AND credit_account='2100') OR
  (debit_account='2100' AND credit_account='5100') OR
  (debit_account='5300' AND credit_account='1500') OR
  (debit_account='1500' AND credit_account='5300') OR
  (debit_account='5400' AND credit_account='1190') OR
  (debit_account='1190' AND credit_account='5400') OR
  (debit_account='6100' AND credit_account='2100') OR
  (debit_account='2100' AND credit_account='6100')
 )
);
CREATE INDEX IF NOT EXISTS financial_accrual_journals_period_idx
 ON public.financial_accrual_journals(tenant_id,site_id,period,status,id);
ALTER TABLE public.financial_accrual_journals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_accrual_journals FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.financial_accrual_journals TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.financial_accrual_journals_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_journal_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $guard$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'ACCRUAL_JOURNAL_DELETE_DENIED' USING ERRCODE='22023';
 ELSIF TG_OP='UPDATE' THEN
  IF OLD.status<>'draft' OR NEW.status<>'posted'
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
    OR NEW.approved_at IS NULL THEN
   RAISE EXCEPTION 'ACCRUAL_JOURNAL_IMMUTABLE' USING ERRCODE='22023';
  END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$guard$;
DROP TRIGGER IF EXISTS financial_accrual_journal_immutable ON public.financial_accrual_journals;
CREATE TRIGGER financial_accrual_journal_immutable
 BEFORE UPDATE OR DELETE ON public.financial_accrual_journals
 FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_accrual_journal_guard();

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
      AND operation_key=p_operation_key AND created_by_user_id=p_user_id AND period=p_period) THEN
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

REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_journal_create(bigint,bigint,bigint,text,text,text,numeric,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_journal_post(bigint,bigint,bigint,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_journal_reverse(bigint,bigint,bigint,bigint,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_journal_create(bigint,bigint,bigint,text,text,text,numeric,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_journal_post(bigint,bigint,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_journal_reverse(bigint,bigint,bigint,bigint,text,text,text) TO service_role;
COMMENT ON TABLE public.financial_accrual_journals IS 'Append-only balanced accrual adjustment subledger; not a replacement for existing cash books or complete general ledger.';
NOTIFY pgrst,'reload schema';
