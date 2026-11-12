-- MANUAL STAGING DATA CORRECTION ONLY. NEVER PRODUCTION OR RELEASE MIGRATION.
-- No human financial approval is asserted. Original GL remains immutable.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $test$
DECLARE o public.financial_gl_opening_batches%ROWTYPE;
e public.financial_gl_entries%ROWTYPE;
v_entry bigint; v_fingerprint text; v_cash jsonb; v_ev jsonb; v_roll jsonb;
BEGIN
PERFORM pg_advisory_xact_lock(hashtextextended('powerhub:gl-site:1:9000000000099',0));
IF NOT EXISTS(SELECT 1 FROM public.sites WHERE tenant_id=1 AND id=9000000000099
 AND name='STAGING Finance A Isolated Acceptance (TEST ONLY)' AND status='active')
THEN RAISE EXCEPTION 'STAGING_ONLY_ENVIRONMENT_GUARD'; END IF;
SELECT * INTO o FROM public.financial_gl_opening_batches
 WHERE id=19 AND tenant_id=1 AND site_id=9000000000099 FOR SHARE;
SELECT * INTO e FROM public.financial_gl_entries
 WHERE id=168 AND tenant_id=1 AND site_id=9000000000099 FOR SHARE;
IF o.id IS NULL OR e.id IS NULL OR o.status<>'posted'
 OR o.evidence_reference<>'STG-FIN-A-OPENING-TEST-20261109'
 OR o.source_fingerprint<>'56991cd37e9f908daac5853fc1ca64cbc5bdb7f92f3c399c31713c4e1dd1048e'
 OR e.source_fingerprint<>o.source_fingerprint OR e.source_type<>'opening_balance'
 OR e.source_id<>'19' OR e.period<>'2026-01'
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE entry_id=168)<>2
 OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines WHERE entry_id=168 AND account_code='1010' AND side='debit' AND amount=2000)
 OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines WHERE entry_id=168 AND account_code='3100' AND side='credit' AND amount=2000)
THEN RAISE EXCEPTION 'STAGING_OPENING_SOURCE_CHANGED'; END IF;
v_fingerprint:=encode(digest('staging-only:opening19:entry168:2000:1010:3100:'||e.source_fingerprint,'sha256'),'hex');
SELECT id INTO v_entry FROM public.financial_gl_entries
 WHERE tenant_id=1 AND site_id=9000000000099
 AND operation_key='gl:correction:staging-opening19:technical:v1';
IF v_entry IS NULL THEN
 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>24
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>49
 OR EXISTS(SELECT 1 FROM public.financial_gl_entries WHERE reverses_entry_id=168)
 THEN RAISE EXCEPTION 'STAGING_REVERSAL_BASELINE_CHANGED'; END IF;
 INSERT INTO public.financial_gl_entries
  (tenant_id,site_id,period,source_type,source_id,source_revision,operation_key,
   source_fingerprint,accounting_policy_version,posted_by_user_id,reverses_entry_id)
 VALUES(1,9000000000099,'2026-11','correction','staging-opening19-technical',1,
  'gl:correction:staging-opening19:technical:v1',v_fingerprint,
  'staging-prelaunch-technical-disposition-v1',4,168)
 RETURNING id INTO v_entry;
 INSERT INTO public.financial_gl_lines(entry_id,tenant_id,site_id,account_code,side,amount)
 VALUES(v_entry,1,9000000000099,'3100','debit',2000),
       (v_entry,1,9000000000099,'1010','credit',2000);
 INSERT INTO public.audit_logs(tenant_id,site_id,user_id,entity_type,entity_id,action,after_data,metadata)
 VALUES(1,9000000000099,NULL,'financial_gl_entries',v_entry::text,
 'STAGING_PRELAUNCH_TEST_OPENING_TECHNICAL_REVERSAL',
 jsonb_build_object('originalEntryId',168,'openingId',19,'reversalEntryId',v_entry,
 'amount',2000,'sourceFingerprint',v_fingerprint,
 'isSynthetic',true,'humanApproved',false,'accountingCertification','NOT_CERTIFIED'),
 jsonb_build_object('reason','Unsubstantiated isolated synthetic opening; append-only technical correction',
 'userAuthorizedStagingTestEdit',true,'postedByUserIdIsTechnicalAttributionOnly',true,
 'humanApprovalNotClaimed',true,'productionAllowed',false));
END IF;
IF NOT EXISTS(SELECT 1 FROM public.financial_gl_entries g
 WHERE g.id=v_entry AND g.tenant_id=1 AND g.site_id=9000000000099
 AND g.reverses_entry_id=168 AND g.source_fingerprint=v_fingerprint
 AND g.accounting_policy_version='staging-prelaunch-technical-disposition-v1')
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE entry_id=v_entry)<>2
 OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines WHERE entry_id=v_entry
   AND account_code='1010' AND side='credit' AND amount=2000)
 OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines WHERE entry_id=v_entry
   AND account_code='3100' AND side='debit' AND amount=2000)
 OR (SELECT count(*) FROM public.audit_logs WHERE tenant_id=1
   AND site_id=9000000000099 AND entity_id=v_entry::text
   AND action='STAGING_PRELAUNCH_TEST_OPENING_TECHNICAL_REVERSAL'
   AND user_id IS NULL AND after_data->>'humanApproved'='false')<>1
 THEN RAISE EXCEPTION 'STAGING_REVERSAL_OR_AUDIT_INTEGRITY_FAILURE'; END IF;
SELECT x INTO v_cash FROM jsonb_array_elements(
 public.powerhub_financial_gl_subledger_reconciliation(1,9000000000099,'2026-11')->'checks') x WHERE x->>'code'='1010';
v_ev:=public.powerhub_financial_gl_opening_evidence_status(1,9000000000099,'2026-11');
v_roll:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
IF (v_cash->>'difference')::numeric<>0 OR
 (v_ev->>'isIndependentlyReconciled')::boolean IS DISTINCT FROM false
 OR v_roll->>'accountingCertification'<>'NOT_CERTIFIED'
 OR (v_roll->>'isConsolidatedFinancialStatements')::boolean IS DISTINCT FROM false
 OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>25
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>51
THEN RAISE EXCEPTION 'STAGING_REVERSAL_VERIFICATION_FAILURE'; END IF;
END;$test$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'B4_10_STAGING_TECHNICAL_REVERSAL_VERIFIED_NOT_CERTIFIED' AS result;
-- Operator must verify environment and replace ROLLBACK with COMMIT only for authorized synthetic Staging reset.
ROLLBACK;
