-- D36: source coverage locks financial source rows FOR SHARE. PostgREST places
-- STABLE RPC calls in read-only transactions, where that lock is forbidden.
-- Keep the locks and request the read-write transaction mode. This report
-- performs no persistent write and remains callable only by service_role.
ALTER FUNCTION public.powerhub_financial_gl_trial_balance(bigint,bigint,text) VOLATILE;

REVOKE ALL ON FUNCTION public.powerhub_financial_gl_trial_balance(bigint,bigint,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_trial_balance(bigint,bigint,text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
