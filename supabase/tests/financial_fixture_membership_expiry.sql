-- Disposable PostgreSQL 17 only. Synthetic actors, no hosted project or human
-- approvals. Reuse the real GL/source fixture and its original migrations.
\set ON_ERROR_STOP on
\ir financial_gl_operational_sources_integration.sql
-- Match Supabase's privileged role in this disposable cluster. Browser roles
-- retain ordinary RLS behavior; all business constraints/triggers remain active.
ALTER ROLE service_role BYPASSRLS;
ALTER TABLE public.tenant_members ADD COLUMN expires_at timestamptz;
ALTER TABLE public.account_transactions ADD COLUMN description text;
ALTER TABLE public.account_transactions ADD COLUMN created_by_user_id bigint;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO service_role;
ALTER TABLE public.users ADD COLUMN platform_role text;
ALTER TABLE public.payroll_runs ADD COLUMN updated_at timestamptz;
CREATE TABLE public.financial_settlements(tenant_id bigint,site_id bigint,status text,period_start timestamptz,period_end timestamptz);
CREATE TABLE public.audit_logs(tenant_id bigint,site_id bigint,user_id bigint,actor_platform_role text,entity_type text,entity_id text,action text,after_data jsonb);
\ir ../migrations/20261110023000_powerhub_payroll_approval_integrity.sql
\ir ../migrations/20261110091920_powerhub_financial_review_membership_expiry.sql
-- Replaying this forward-only repair must preserve all existing contracts.
\ir ../migrations/20261110091920_powerhub_financial_review_membership_expiry.sql

BEGIN;
INSERT INTO public.tenants(id) VALUES(1),(2);
INSERT INTO public.sites(id,tenant_id,status) VALUES(1,1,'active'),(2,2,'active');
INSERT INTO public.users(id,account_status)
VALUES(9911,'active'),(9912,'active'),(9913,'active'),(9914,'disabled');
INSERT INTO public.tenant_members(tenant_id,user_id,is_active,membership_status,role,expires_at)
VALUES(1,9911,true,'active','owner',NULL),
      (1,9912,true,'active','accountant',statement_timestamp()+interval '1 day'),
      (1,9913,true,'active','owner',statement_timestamp()-interval '1 day'),
      (1,9914,true,'active','owner',NULL),
      (2,9911,true,'active','owner',NULL);
GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;
GRANT SELECT ON public.users,public.tenant_members,public.account_transactions TO service_role;

SET ROLE service_role;
DO $expiry$
DECLARE first_id bigint; retry_id bigint; rejected boolean;
BEGIN
 -- Expiry must be rejected by the RPC before any manifest exists.
 rejected:=false;
 BEGIN
  PERFORM public.powerhub_financial_gl_fixture_manifest_prepare(1,1,9913);
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM<>'GL_FIXTURE_PREPARER_FORBIDDEN' THEN RAISE;END IF;
  rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'EXPIRED_FIXTURE_PREPARER_ACCEPTED';END IF;
 IF EXISTS(SELECT 1 FROM public.financial_gl_staging_fixture_manifests) THEN
  RAISE EXCEPTION 'EXPIRED_FIXTURE_PREPARER_LEFT_PARTIAL_MANIFEST';END IF;
 -- Direct privileged INSERT must not bypass the actor check.
 rejected:=false;
 BEGIN
  INSERT INTO public.financial_gl_staging_fixture_manifests(
   tenant_id,site_id,cohort_key,row_count,sha256,prepared_by_user_id)
  VALUES(1,1,'STG-PERF-20261105',250000,
   'f1b25e8562328a0f6e916beb4d54b2ee88366e78b4459c5d0ebc444616997df9',9913);
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM<>'GL_FIXTURE_PREPARER_FORBIDDEN' THEN RAISE;END IF;
  rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'EXPIRED_FIXTURE_PREPARER_DIRECT_INSERT';END IF;

 first_id:=public.powerhub_financial_gl_fixture_manifest_prepare(1,1,9911);
 retry_id:=public.powerhub_financial_gl_fixture_manifest_prepare(1,1,9911);
 IF first_id IS NULL OR first_id<>retry_id OR
    (SELECT count(*) FROM public.financial_gl_staging_fixture_manifests)<>1 THEN
  RAISE EXCEPTION 'ACTIVE_FIXTURE_PREPARE_RETRY_DUPLICATED';END IF;
 rejected:=false;
 BEGIN
  PERFORM public.powerhub_financial_gl_fixture_manifest_review(1,1,first_id,9913);
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM<>'GL_FIXTURE_REVIEWER_FORBIDDEN' THEN RAISE;END IF;
  rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'EXPIRED_FIXTURE_REVIEWER_ACCEPTED';END IF;
 rejected:=false;
 BEGIN
  UPDATE public.financial_gl_staging_fixture_manifests
  SET status='verified',reviewed_by_user_id=9913,reviewed_at=statement_timestamp()
  WHERE id=first_id;
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM<>'GL_FIXTURE_REVIEWER_NOT_AUTHORIZED' THEN RAISE;END IF;
  rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'EXPIRED_FIXTURE_REVIEWER_DIRECT_UPDATE';END IF;
 -- The same active preparer must still never approve their own manifest.
 rejected:=false;
 BEGIN
  PERFORM public.powerhub_financial_gl_fixture_manifest_review(1,1,first_id,9911);
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM<>'GL_FIXTURE_SELF_REVIEW' THEN RAISE;END IF;
  rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'FIXTURE_SELF_REVIEW_ACCEPTED';END IF;
 -- An active independent checker reaches the actual content check. Missing
 -- cohort data must roll back the entire status transition, never approve it.
 rejected:=false;
 BEGIN
  PERFORM public.powerhub_financial_gl_fixture_manifest_review(1,1,first_id,9912);
 EXCEPTION WHEN SQLSTATE '23514' THEN
  IF SQLERRM<>'GL_FIXTURE_REVIEW_CONTENT_MISMATCH: COHORT_CONTENT_OR_BALANCE_DRIFT'
  THEN RAISE;END IF;
  rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'FIXTURE_MISSING_CONTENT_ACCEPTED';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.financial_gl_staging_fixture_manifests
  WHERE id=first_id AND status='pending' AND reviewed_by_user_id IS NULL
    AND reviewed_at IS NULL AND prepared_by_user_id=9911) THEN
  RAISE EXCEPTION 'FAILED_FIXTURE_REVIEW_LEFT_PARTIAL_APPROVAL';END IF;
 rejected:=false;
 BEGIN
  PERFORM public.powerhub_financial_gl_fixture_manifest_prepare(1,1,9914);
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM<>'GL_FIXTURE_PREPARER_FORBIDDEN' THEN RAISE;END IF;
  rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'DISABLED_FIXTURE_PREPARER_ACCEPTED';END IF;
 rejected:=false;
 BEGIN
  PERFORM public.powerhub_financial_gl_fixture_manifest_prepare(2,2,9911);
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM<>'GL_FIXTURE_SCOPE_FORBIDDEN' THEN RAISE;END IF;
  rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'OTHER_TENANT_FIXTURE_MANIFEST_ACCEPTED';END IF;
 rejected:=false;
 BEGIN
  PERFORM public.powerhub_financial_gl_fixture_manifest_prepare(1,NULL,9911);
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM<>'GL_FIXTURE_SCOPE_FORBIDDEN' THEN RAISE;END IF;
  rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'NULL_SITE_FIXTURE_MANIFEST_ACCEPTED';END IF;
END;
$expiry$;
RESET ROLE;

-- Membership revocation after preparation must be rechecked on retries.
UPDATE public.tenant_members SET expires_at=statement_timestamp()
WHERE tenant_id=1 AND user_id=9911;
SET ROLE service_role;
DO $retry_expiry$
BEGIN
 BEGIN
  PERFORM public.powerhub_financial_gl_fixture_manifest_prepare(1,1,9911);
  RAISE EXCEPTION 'EXPIRED_FIXTURE_PREPARER_RETRY_ACCEPTED';
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM<>'GL_FIXTURE_PREPARER_FORBIDDEN' THEN RAISE;END IF;
 END;
END;
$retry_expiry$;
RESET ROLE;

SET ROLE authenticated;
DO $browser_denial$
BEGIN
 BEGIN
  PERFORM public.powerhub_financial_gl_fixture_manifest_prepare(1,1,9912);
  RAISE EXCEPTION 'BROWSER_FIXTURE_PREPARE_BYPASS';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN
  PERFORM public.powerhub_financial_gl_fixture_manifest_review(1,1,1,9912);
  RAISE EXCEPTION 'BROWSER_FIXTURE_REVIEW_BYPASS';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END;
$browser_denial$;
RESET ROLE;
-- Full-sized independent negative cohort: the right count, balance and prefix
-- are insufficient. Keep the real SHA-256 function and immutable known hash.
-- This synthetic dataset is deliberately NOT the original Staging row payload.
INSERT INTO public.company_accounts(id,tenant_id,account_type)
VALUES(5,1,'cash'),(6,1,'palpay');
INSERT INTO public.account_transactions(
 id,tenant_id,site_id,account_id,transaction_type,amount,reference_no,
 occurred_at,description,created_by_user_id)
SELECT n,1,1,CASE WHEN n<=125000 THEN 5 ELSE 6 END,
 CASE WHEN n%2=0 THEN 'collection' ELSE 'withdrawal' END,
 CASE WHEN ((n-1)%125000)+1<=50000 THEN 125.00 ELSE 1.00 END,
 'STG-PERF-20261105-'||lpad(n::text,6,'0'),
 '2026-05-01 00:00:00+00'::timestamptz+(n%3)*interval '1 day',
 CASE WHEN ((n-1)%125000)+1<=50000
 THEN 'Synthetic Staging performance fixture (100k); not a real financial movement'
 ELSE 'Synthetic 250k scale benchmark movement' END,NULL
FROM generate_series(1,250000) n;
SET ROLE service_role;
DO $full_cohort$
DECLARE manifest_id bigint; started_at timestamptz:=clock_timestamp();
BEGIN
 IF (SELECT count(*) FROM public.account_transactions WHERE tenant_id=1 AND site_id=1)<>250000
 OR EXISTS(SELECT account_id FROM public.account_transactions
  WHERE tenant_id=1 AND site_id=1 GROUP BY account_id
  HAVING count(*)<>125000
   OR count(*) FILTER(WHERE transaction_type='collection')<>62500
   OR sum(CASE WHEN transaction_type='collection' THEN amount ELSE -amount END)<>0)
 THEN RAISE EXCEPTION 'SYNTHETIC_250K_COHORT_FIXTURE_INVALID';END IF;
 SELECT id INTO manifest_id FROM public.financial_gl_staging_fixture_manifests;
 BEGIN
  PERFORM public.powerhub_financial_gl_fixture_manifest_review(1,1,manifest_id,9912);
  RAISE EXCEPTION 'WRONG_250K_PAYLOAD_FINGERPRINT_WAS_APPROVED';
 EXCEPTION WHEN SQLSTATE '23514' THEN
  IF SQLERRM<>'GL_FIXTURE_REVIEW_CONTENT_MISMATCH: COHORT_CONTENT_OR_BALANCE_DRIFT'
  THEN RAISE;END IF;
 END;
 IF NOT EXISTS(SELECT 1 FROM public.financial_gl_staging_fixture_manifests
  WHERE id=manifest_id AND status='pending' AND reviewed_by_user_id IS NULL)
 OR (SELECT count(*) FROM public.account_transactions WHERE tenant_id=1 AND site_id=1)<>250000
 THEN RAISE EXCEPTION 'WRONG_250K_FINGERPRINT_LEFT_MUTATED_DATA';END IF;
 RAISE NOTICE 'PASS: real 250k-row SHA-256 rejection elapsed_ms=%',
  extract(epoch FROM clock_timestamp()-started_at)*1000;
END;
$full_cohort$;
RESET ROLE;
-- The same financial actor rule applies to evidence and payroll approval.
-- These are internally documented synthetic sources, never external certificates.
DO $opening_setup$
DECLARE batch jsonb;
BEGIN
 batch:=public.powerhub_financial_gl_opening_create(901,9101,9901,'2026-01-01',
  'CI-EXPIRY-SYNTHETIC-OPENING','Synthetic opening solely for membership expiry regression',
  'ci-expiry-opening-v1',
  '[{"accountCode":"1010","side":"debit","amount":13,"evidenceReference":"CI-SYNTHETIC-CASH"},
    {"accountCode":"3100","side":"credit","amount":13,"evidenceReference":"CI-SYNTHETIC-EQUITY"}]');
 PERFORM public.powerhub_financial_gl_opening_post(901,9101,(batch->>'openingId')::bigint,9902);
END;
$opening_setup$;
UPDATE public.tenant_members SET expires_at=statement_timestamp()-interval '1 day'
WHERE tenant_id=901 AND user_id IN(9903,9904);
GRANT SELECT,UPDATE ON public.payroll_runs TO service_role;
GRANT SELECT ON public.financial_settlements TO service_role;
GRANT SELECT,INSERT ON public.audit_logs TO service_role;
SET ROLE service_role;
DO $expired_evidence_submit$
DECLARE batch_id bigint; line_id bigint; rejected boolean:=false;
BEGIN
 SELECT b.id,l.id INTO batch_id,line_id
 FROM public.financial_gl_opening_batches b JOIN public.financial_gl_opening_lines l
 ON l.opening_id=b.id AND l.account_code='1010' WHERE b.tenant_id=901 AND b.site_id=9101;
 BEGIN
  PERFORM public.powerhub_financial_gl_opening_evidence_submit(901,9101,batch_id,line_id,
   'company_account_statement','CI-SYNTHETIC-EXPIRY-CASH',repeat('a',64),
   '2026-01-01','debit',13,9904);
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM<>'GL_OPENING_EVIDENCE_ACTOR_FORBIDDEN' THEN RAISE;END IF;
  rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'EXPIRED_OPENING_EVIDENCE_SUBMITTER_ACCEPTED';END IF;
 rejected:=false;
 BEGIN
  INSERT INTO public.financial_gl_opening_evidence(tenant_id,site_id,opening_id,
   opening_line_id,source_kind,source_reference,source_document_sha256,
   source_as_of_date,supported_side,supported_amount,prepared_by_user_id)
  VALUES(901,9101,batch_id,line_id,'company_account_statement',
   'CI-SYNTHETIC-EXPIRY-CASH',repeat('a',64),'2026-01-01','debit',13,9904);
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM<>'GL_OPENING_EVIDENCE_ACTOR_FORBIDDEN' THEN RAISE;END IF;
  rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'EXPIRED_OPENING_EVIDENCE_DIRECT_INSERT';END IF;
END;
$expired_evidence_submit$;
RESET ROLE;
UPDATE public.tenant_members SET expires_at=statement_timestamp()+interval '1 day'
WHERE tenant_id=901 AND user_id=9904;
SET ROLE service_role;
DO $evidence_review$
DECLARE batch_id bigint; line_id bigint; evidence_id bigint; replay_id bigint;
 rejected boolean:=false;
BEGIN
 SELECT b.id,l.id INTO batch_id,line_id
 FROM public.financial_gl_opening_batches b JOIN public.financial_gl_opening_lines l
 ON l.opening_id=b.id AND l.account_code='1010' WHERE b.tenant_id=901 AND b.site_id=9101;
 evidence_id:=public.powerhub_financial_gl_opening_evidence_submit(901,9101,batch_id,line_id,
  'company_account_statement','CI-SYNTHETIC-EXPIRY-CASH',repeat('a',64),
  '2026-01-01','debit',13,9904);
 replay_id:=public.powerhub_financial_gl_opening_evidence_submit(901,9101,batch_id,line_id,
  'company_account_statement','CI-SYNTHETIC-EXPIRY-CASH',repeat('a',64),
  '2026-01-01','debit',13,9904);
 IF evidence_id<>replay_id THEN RAISE EXCEPTION 'OPENING_EVIDENCE_RETRY_DUPLICATED';END IF;
 BEGIN
  PERFORM public.powerhub_financial_gl_opening_evidence_review(901,9101,evidence_id,
   9903,true,'Synthetic independent review only');
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM<>'GL_OPENING_EVIDENCE_REVIEWER_FORBIDDEN' THEN RAISE;END IF;
  rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'EXPIRED_OPENING_EVIDENCE_REVIEWER_ACCEPTED';END IF;
 rejected:=false;
 BEGIN
  UPDATE public.financial_gl_opening_evidence SET review_status='verified',
   reviewed_by_user_id=9903,reviewed_at=statement_timestamp(),
   review_note='Synthetic independent review only' WHERE id=evidence_id;
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM<>'GL_OPENING_EVIDENCE_REVIEW_NOT_INDEPENDENT' THEN RAISE;END IF;
  rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'EXPIRED_OPENING_EVIDENCE_DIRECT_REVIEW';END IF;
 IF (SELECT review_status FROM public.financial_gl_opening_evidence WHERE id=evidence_id)<>'pending'
 THEN RAISE EXCEPTION 'EXPIRED_REVIEW_LEFT_APPROVED_EVIDENCE';END IF;
 -- A28: the expiry test also needs a matching private custody record before
 -- an active reviewer may approve. This is disposable SQL-only evidence;
 -- the actual server independently re-downloads the stored file.
 INSERT INTO public.financial_gl_opening_document_custody(
   evidence_id,tenant_id,site_id,opening_id,opening_line_id,storage_key,
   document_sha256,mime_type,byte_size,recorded_by_user_id
 ) VALUES (evidence_id,901,9101,batch_id,line_id,
   'financial-opening-evidence/901/9101/'||batch_id||'/'||
   line_id||'/'||evidence_id||'.pdf',
   repeat('a',64),'application/pdf',128,9904);
END;
$evidence_review$;
RESET ROLE;
UPDATE public.tenant_members SET expires_at=statement_timestamp()+interval '1 day'
WHERE tenant_id=901 AND user_id=9903;
SET ROLE service_role;
DO $active_evidence_review$
DECLARE evidence_id bigint; result jsonb;
BEGIN
 SELECT id INTO evidence_id FROM public.financial_gl_opening_evidence WHERE tenant_id=901;
 result:=public.powerhub_financial_gl_opening_evidence_review(901,9101,evidence_id,
  9903,true,'Synthetic independent review only');
 IF result->>'status'<>'verified' OR (result->>'replayed')::boolean THEN
  RAISE EXCEPTION 'ACTIVE_OPENING_REVIEW_REJECTED';END IF;
 result:=public.powerhub_financial_gl_opening_evidence_review(901,9101,evidence_id,
  9903,true,'Synthetic independent review only');
 IF NOT (result->>'replayed')::boolean THEN RAISE EXCEPTION 'OPENING_REVIEW_RETRY_DUPLICATED';END IF;
END;
$active_evidence_review$;
RESET ROLE;
UPDATE public.tenant_members SET expires_at=statement_timestamp()-interval '1 day'
WHERE tenant_id=901 AND user_id IN(9902,9903);
INSERT INTO public.payroll_runs(id,tenant_id,site_id,period,status,created_by_user_id)
VALUES(1499,901,9101,'2026-10','draft',9901);
SET ROLE service_role;
DO $expired_review_retries$
DECLARE evidence_id bigint; rejected boolean:=false;
BEGIN
 SELECT id INTO evidence_id FROM public.financial_gl_opening_evidence WHERE tenant_id=901;
 BEGIN
  PERFORM public.powerhub_financial_gl_opening_evidence_review(901,9101,evidence_id,
   9903,true,'Synthetic independent review only');
  RAISE EXCEPTION 'EXPIRED_OPENING_REVIEW_REPLAY_ACCEPTED';
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM<>'GL_OPENING_EVIDENCE_REVIEWER_FORBIDDEN' THEN RAISE;END IF;
 END;
 BEGIN
  PERFORM public.powerhub_approve_payroll(901,9101,9902,1499);
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM<>'PAYROLL_APPROVER_OUT_OF_TENANT' THEN RAISE;END IF;
  rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'EXPIRED_PAYROLL_APPROVER_ACCEPTED';END IF;
 IF (SELECT status FROM public.payroll_runs WHERE id=1499)<>'draft'
 OR EXISTS(SELECT 1 FROM public.audit_logs WHERE entity_id='1499') THEN
  RAISE EXCEPTION 'EXPIRED_PAYROLL_APPROVAL_LEFT_PARTIAL_RESULT';END IF;
END;
$expired_review_retries$;
RESET ROLE;
UPDATE public.tenant_members SET expires_at=NULL WHERE tenant_id=901 AND user_id=9902;
SET ROLE service_role;
SELECT public.powerhub_approve_payroll(901,9101,9902,1499);
SELECT public.powerhub_approve_payroll(901,9101,9902,1499);
DO $payroll_exactly_once$
BEGIN
 IF (SELECT count(*) FROM public.audit_logs WHERE entity_id='1499')<>1 THEN
  RAISE EXCEPTION 'PAYROLL_APPROVAL_RETRY_AUDIT_DUPLICATED';END IF;
END;
$payroll_exactly_once$;
RESET ROLE;
UPDATE public.tenant_members SET expires_at=statement_timestamp()-interval '1 day'
WHERE tenant_id=901 AND user_id=9902;
SET ROLE service_role;
DO $expired_payroll_retry$
BEGIN
 BEGIN
  PERFORM public.powerhub_approve_payroll(901,9101,9902,1499);
  RAISE EXCEPTION 'EXPIRED_PAYROLL_REPLAY_ACCEPTED';
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM<>'PAYROLL_APPROVER_OUT_OF_TENANT' THEN RAISE;END IF;
 END;
END;
$expired_payroll_retry$;
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
SELECT 'PASS: fixture membership expiry, server bypass, retry, rollback, tenant scope and browser ACL' AS acceptance;
