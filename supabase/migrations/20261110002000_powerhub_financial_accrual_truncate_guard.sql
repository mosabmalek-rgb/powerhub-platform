-- Critical: row-level DELETE guards cannot prevent TRUNCATE.
-- Block table-wide truncation and remove unnecessary service_role privileges.
CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_forbid_truncate()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp
AS $body$
BEGIN
  RAISE EXCEPTION 'ACCRUAL_AUDIT_TABLE_TRUNCATE_DENIED' USING ERRCODE='22023';
END
$body$;
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_forbid_truncate()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_forbid_truncate()
  TO service_role;

DROP TRIGGER IF EXISTS financial_accrual_journals_no_truncate
  ON public.financial_accrual_journals;
CREATE TRIGGER financial_accrual_journals_no_truncate
  BEFORE TRUNCATE ON public.financial_accrual_journals
  FOR EACH STATEMENT EXECUTE FUNCTION public.powerhub_financial_accrual_forbid_truncate();
DROP TRIGGER IF EXISTS financial_accrual_reviews_no_truncate
  ON public.financial_accrual_period_reviews;
CREATE TRIGGER financial_accrual_reviews_no_truncate
  BEFORE TRUNCATE ON public.financial_accrual_period_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION public.powerhub_financial_accrual_forbid_truncate();

REVOKE ALL ON public.financial_accrual_journals FROM service_role;
REVOKE ALL ON public.financial_accrual_period_reviews FROM service_role;
GRANT SELECT,INSERT,UPDATE ON public.financial_accrual_journals TO service_role;
GRANT SELECT,INSERT,UPDATE ON public.financial_accrual_period_reviews TO service_role;
REVOKE ALL ON public.financial_accrual_journals FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.financial_accrual_period_reviews FROM PUBLIC,anon,authenticated;
COMMENT ON FUNCTION public.powerhub_financial_accrual_forbid_truncate()
 IS 'Audit retention safety: deny TRUNCATE on accrual journals and period review evidence.';
