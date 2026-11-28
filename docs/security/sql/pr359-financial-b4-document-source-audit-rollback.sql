-- B4.1 live Staging regression, all reads; transaction always rolls back.
BEGIN;
SET LOCAL statement_timeout='90000ms';
DO $qa$
DECLARE main jsonb; oct jsonb; secondary jsonb;
BEGIN
 main:=public.powerhub_financial_gl_subledger_document_audit(1,1,'2026-11');
 oct:=public.powerhub_financial_gl_subledger_document_audit(1,1,'2026-10');
 secondary:=public.powerhub_financial_gl_subledger_document_audit(1,9000000000099,'2026-11');
 IF main->>'status'<>'DOCUMENT_SOURCES_MATCHED_NOT_CERTIFIED'
 OR main->>'accountingCertification'<>'NOT_CERTIFIED'
 OR (main->>'isApproved')::boolean IS DISTINCT FROM false
 OR (main->>'sourceCount')::bigint<>16
 OR (main->>'mismatchCount')::bigint<>0
 OR (main->>'orphanGLEntryCount')::bigint<>0
 OR (main->>'transferMovementCount')::bigint<>4
 OR (main->>'transferCostNet')::numeric<>0
 OR oct->>'status'<>'DOCUMENT_SOURCES_MATCHED_NOT_CERTIFIED'
 OR (oct->>'sourceCount')::bigint<>6
 OR secondary->>'status'<>'BLOCKED_DOCUMENT_RECONCILIATION'
 OR (secondary->>'aggregateUnresolvedCount')::bigint<>1
 OR (secondary->>'sourceCount')::bigint<>0
 THEN RAISE EXCEPTION 'B4_1_DOCUMENT_AUDIT_MISMATCH'; END IF;
 BEGIN
  PERFORM public.powerhub_financial_gl_subledger_document_audit(9000000000001,1,'2026-11');
  RAISE EXCEPTION 'B4_1_CROSS_TENANT_BYPASS';
 EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 IF has_function_privilege('anon','public.powerhub_financial_gl_subledger_document_audit(bigint,bigint,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_gl_subledger_document_audit(bigint,bigint,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_gl_subledger_document_audit(bigint,bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'B4_1_RPC_EXECUTE_EXPOSURE'; END IF;
 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>24
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>49
 THEN RAISE EXCEPTION 'B4_1_UNEXPECTED_GL_MUTATION'; END IF;
END;$qa$;
SELECT 'B4_1_PASS_ROLLBACK_ONLY' AS result;
ROLLBACK;
