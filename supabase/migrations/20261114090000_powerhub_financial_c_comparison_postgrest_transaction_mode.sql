-- The comparison calls B1 source integrity, which locks source rows FOR SHARE.
-- PostgREST executes STABLE RPCs in a read-only transaction, causing SQLSTATE
-- 25006 / HTTP 405. Keep the source locks; request a read-write transaction.
-- This function performs no persistent writes.
ALTER FUNCTION public.powerhub_financial_gl_monthly_comparison(bigint,bigint,text,text) VOLATILE;

REVOKE ALL ON FUNCTION public.powerhub_financial_gl_monthly_comparison(bigint,bigint,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_monthly_comparison(bigint,bigint,text,text)
  TO service_role;
