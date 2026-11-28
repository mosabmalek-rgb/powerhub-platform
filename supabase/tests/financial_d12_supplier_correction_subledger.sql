-- D12 disposable code and ACL regression; full reconciliation runtime is
-- tested on installed Staging functions in a rolled-back real operation.
\set ON_ERROR_STOP on
\ir financial_d11_supplier_refund_subledger_cash.sql
\ir ../migrations/20261115160000_powerhub_financial_d12_supplier_correction_cash_subledger.sql
DO $d12$
DECLARE d text;
BEGIN
 SELECT pg_get_functiondef('public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text)'::regprocedure) INTO d;
 IF position('v_correction_valid_count' IN d)=0
 OR position('supplier-payment-source-correction-v1' IN d)=0
 OR position('SOURCE_BACKED_REVERSAL_VALID' IN d)=0
 OR position('v_refund_valid_count' IN d)=0
 OR position('STG-PERF-20261105' IN d)=0
 OR position('powerhub_financial_gl_fast_staging_fixture_proof' IN d)=0
 OR has_function_privilege('authenticated','public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text)','EXECUTE')
 OR has_function_privilege('anon','public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'D12_SUBLEDGER_SOURCE_OR_ACL_REGRESSION'; END IF;
 RAISE NOTICE 'D12_DISPOSABLE_SUBLEDGER_GUARDS_PASS';
END;$d12$;
SELECT 'D12_DISPOSABLE_SUBLEDGER_GUARDS_PASS' AS acceptance;
