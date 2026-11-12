-- B4.11 correction readiness: strict pagination, scope, existing reversal and no GL mutation.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $qa$
DECLARE one jsonb; page jsonb; other_site jsonb;
 base_entries bigint;base_lines bigint; invalid_scope boolean:=false;
BEGIN
 SELECT count(*) INTO base_entries FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT count(*) INTO base_lines FROM public.financial_gl_lines WHERE tenant_id=1;
 IF base_entries<>25 OR base_lines<>51 THEN RAISE EXCEPTION 'B411_BASELINE_CHANGED';END IF;
 one:=public.powerhub_financial_gl_correction_readiness(1,9000000000099,'2026-09',25,NULL);
 IF one->>'accountingCertification'<>'NOT_CERTIFIED' OR one->>'glOnlyReversalAllowed'<>'false'
 OR one->>'isFinalFinancialAcceptance'<>'false'
 OR one->>'returnedCount'<>'1'
 OR one->'items'->0->>'entryId'<>'169'
 OR one->'items'->0->>'status'<>'ALREADY_REVERSED'
 OR one->'items'->0->>'existingReversalEntryId'<>'170'
 OR one->'items'->0->>'canReverseGLDirectly'<>'false'
 OR one->'items'->0->>'canPrepareAccrualSourceReversal'<>'false'
 THEN RAISE EXCEPTION 'B411_EXISTING_REVERSAL_INCORRECT';END IF;
 page:=public.powerhub_financial_gl_correction_readiness(1,9000000000099,'2026-10',1,NULL);
 IF page->>'returnedCount'<>'1'
 OR page->'items'->0->>'entryId'<>'170'
 OR page->'items'->0->>'status'<>'REVERSAL_ENTRY_IMMUTABLE'
 THEN RAISE EXCEPTION 'B411_REVERSAL_CLASSIFICATION_INCORRECT';END IF;
 other_site:=public.powerhub_financial_gl_correction_readiness(1,1,'2026-11',2,NULL);
 IF (other_site->>'returnedCount')::int<>2
 OR other_site->>'hasMore'<>'true'
 OR (other_site->>'nextBeforeEntryId')::bigint<=0
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(other_site->'items') item WHERE item->>'canReverseGLDirectly'<>'false')
 THEN RAISE EXCEPTION 'B411_PAGINATION_OR_DIRECT_REVERSAL_ALLOWED';END IF;
 BEGIN
 PERFORM public.powerhub_financial_gl_correction_readiness(1,9000000000099,'2026-11',51,NULL);
 EXCEPTION WHEN SQLSTATE '22023' THEN invalid_scope:=true; END;
 IF NOT invalid_scope THEN RAISE EXCEPTION 'B411_UNBOUNDED_PAGINATION';END IF;
 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>base_entries
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>base_lines
 THEN RAISE EXCEPTION 'B411_READONLY_AUDIT_MUTATED_GL';END IF;
END;$qa$;
SELECT 'B411_SOURCE_FIRST_CORRECTION_READINESS_PASS_ROLLBACK' result;
ROLLBACK;