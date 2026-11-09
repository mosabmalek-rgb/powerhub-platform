-- Immutable journals and close records: server-scoped RPCs are the only intended writers.
-- Database trigger defence-in-depth prevents a service-role bug from silently rewriting history.
CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_journal_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $guard$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'ACCRUAL_JOURNAL_DELETE_DENIED' USING ERRCODE='22023';
 ELSIF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' OR NEW.approved_by_user_id IS NOT NULL OR
      NEW.approved_at IS NOT NULL OR NEW.created_by_user_id IS NULL THEN
   RAISE EXCEPTION 'ACCRUAL_JOURNAL_MUST_START_DRAFT' USING ERRCODE='22023';
  END IF;
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
 RETURN NEW;
END;
$guard$;
DROP TRIGGER IF EXISTS financial_accrual_journal_immutable ON public.financial_accrual_journals;
CREATE TRIGGER financial_accrual_journal_immutable
BEFORE INSERT OR UPDATE OR DELETE ON public.financial_accrual_journals
FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_accrual_journal_guard();

CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_period_review_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $guard$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'ACCRUAL_PERIOD_REVIEW_DELETE_DENIED' USING ERRCODE='22023';
 ELSIF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' OR NEW.locked_by_user_id IS NOT NULL OR
    NEW.locked_at IS NOT NULL OR NEW.locked_snapshot IS NOT NULL OR
    NEW.source_fingerprint IS NOT NULL THEN
   RAISE EXCEPTION 'ACCRUAL_PERIOD_MUST_START_DRAFT' USING ERRCODE='22023';
  END IF;
 ELSIF TG_OP='UPDATE' THEN
  IF OLD.status<>'draft' OR
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.site_id IS DISTINCT FROM OLD.site_id OR
    NEW.period IS DISTINCT FROM OLD.period OR
    NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'ACCRUAL_PERIOD_REVIEW_IMMUTABLE' USING ERRCODE='22023';
  END IF;
  IF NEW.status='draft' THEN
   IF NEW.locked_by_user_id IS NOT NULL OR NEW.locked_at IS NOT NULL OR
     NEW.locked_snapshot IS NOT NULL OR NEW.source_fingerprint IS NOT NULL OR
     NOT public.powerhub_financial_accrual_review_evidence_valid(NEW.evidence) THEN
    RAISE EXCEPTION 'INVALID_ACCRUAL_REVIEW_UPDATE' USING ERRCODE='22023';
   END IF;
  ELSIF NEW.status='locked' THEN
   IF NEW.evidence IS DISTINCT FROM OLD.evidence OR
     NEW.prepared_by_user_id IS DISTINCT FROM OLD.prepared_by_user_id OR
     NEW.prepared_at IS DISTINCT FROM OLD.prepared_at OR
     NEW.locked_by_user_id IS NULL OR NEW.locked_by_user_id=OLD.prepared_by_user_id OR
     NEW.locked_at IS NULL OR NEW.locked_snapshot IS NULL OR
     NEW.source_fingerprint IS NULL THEN
      RAISE EXCEPTION 'INVALID_ACCRUAL_REVIEW_LOCK' USING ERRCODE='22023';
   END IF;
  ELSE
   RAISE EXCEPTION 'INVALID_ACCRUAL_REVIEW_STATE' USING ERRCODE='22023';
  END IF;
 END IF;
 RETURN NEW;
END;
$guard$;
DROP TRIGGER IF EXISTS financial_accrual_review_immutable ON public.financial_accrual_period_reviews;
CREATE TRIGGER financial_accrual_review_immutable
BEFORE INSERT OR UPDATE OR DELETE ON public.financial_accrual_period_reviews
FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_accrual_period_review_guard();

REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_journal_guard() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_period_review_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_journal_guard() TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_period_review_guard() TO service_role;
