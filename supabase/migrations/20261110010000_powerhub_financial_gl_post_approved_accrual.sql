-- Phase A2.1 / forward-only: post already approved accrual-adjustment sources
-- into an append-only GL atomically, one source per transaction.
-- No migration-time posting, no opening-balance fabrication, no GL completeness claim.
--
-- Two contra-asset codes from the pre-existing accrual subledger:
-- 1500 accumulated depreciation, 1190 allowance for doubtful debts.
ALTER TABLE public.financial_gl_accounts
  ADD COLUMN IF NOT EXISTS is_contra boolean NOT NULL DEFAULT false;
ALTER TABLE public.financial_gl_accounts
  DROP CONSTRAINT IF EXISTS financial_gl_accounts_natural_side;
ALTER TABLE public.financial_gl_accounts
  ADD CONSTRAINT financial_gl_accounts_natural_side CHECK (
    (NOT is_contra AND
       ((account_class IN ('asset','expense') AND normal_side='debit') OR
        (account_class IN ('liability','equity','revenue') AND normal_side='credit')))
    OR
    (is_contra AND account_class='asset' AND normal_side='credit')
  );

-- Prior DDL's SELECT-only grants were insufficient on Staging because
-- default service_role grants still included write/delete/truncate. Revoke the
-- inherited direct privileges, then explicitly allow only SELECT+INSERT.
REVOKE ALL ON TABLE public.financial_gl_accounts FROM service_role;
REVOKE ALL ON TABLE public.financial_gl_entries FROM service_role;
REVOKE ALL ON TABLE public.financial_gl_lines FROM service_role;
GRANT SELECT, INSERT ON TABLE public.financial_gl_accounts TO service_role;
GRANT SELECT, INSERT ON TABLE public.financial_gl_entries TO service_role;
GRANT SELECT, INSERT ON TABLE public.financial_gl_lines TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.financial_gl_entries_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.financial_gl_lines_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_post_accrual(
  p_tenant_id bigint, p_site_id bigint, p_journal_id bigint
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $post$
DECLARE
 v_period text;
 v_source public.financial_accrual_journals%ROWTYPE;
 v_entry public.financial_gl_entries%ROWTYPE;
 v_original_entry_id bigint;
 v_fingerprint text;
 v_key text;
 v_pair_count integer;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR
    p_site_id IS NULL OR p_site_id<=0 OR
    p_journal_id IS NULL OR p_journal_id<=0 THEN
   RAISE EXCEPTION 'GL_INVALID_REQUEST' USING ERRCODE='22023';
 END IF;
 -- Resolve period without row locking first. Match the existing accrual
 -- period advisory lock before selecting the source FOR SHARE.
 SELECT j.period INTO v_period
 FROM public.financial_accrual_journals j
 WHERE j.id=p_journal_id AND j.tenant_id=p_tenant_id AND j.site_id=p_site_id;
 IF v_period IS NULL THEN
   RAISE EXCEPTION 'GL_SOURCE_OUT_OF_SCOPE' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:accrual-period:'||p_tenant_id||':'||p_site_id||':'||v_period,0));
 -- Shared site lock serializes the first GL posting against opening approval.
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:gl-site:'||p_tenant_id||':'||p_site_id,0));
 SELECT * INTO v_source FROM public.financial_accrual_journals j
 WHERE j.id=p_journal_id AND j.tenant_id=p_tenant_id AND j.site_id=p_site_id
 FOR SHARE;
 IF NOT FOUND OR v_source.period<>v_period THEN
   RAISE EXCEPTION 'GL_SOURCE_CHANGED_DURING_POST' USING ERRCODE='40001';
 END IF;
 IF v_source.status<>'posted' OR v_source.approved_by_user_id IS NULL
    OR v_source.approved_by_user_id=v_source.created_by_user_id
    OR v_source.approved_at IS NULL THEN
   RAISE EXCEPTION 'GL_SOURCE_NOT_APPROVED' USING ERRCODE='22023';
 END IF;
 IF v_source.amount<=0 OR v_source.amount<>round(v_source.amount,2)
    OR v_source.debit_account=v_source.credit_account THEN
   RAISE EXCEPTION 'GL_SOURCE_AMOUNT_INVALID' USING ERRCODE='22023';
 END IF;
 -- Fingerprint includes immutable approval, scope, accounts, monetary value,
 -- period and reversal origin; it must not rely on client-provided data.
 v_fingerprint:=encode(sha256(convert_to(jsonb_build_object(
   'tenantId',v_source.tenant_id,'siteId',v_source.site_id,
   'journalId',v_source.id,'period',v_source.period,
   'debit',v_source.debit_account,'credit',v_source.credit_account,
   'amount',v_source.amount,'reason',v_source.reason,
   'createdBy',v_source.created_by_user_id,
   'approvedBy',v_source.approved_by_user_id,
   'approvedAt',v_source.approved_at,
   'reverses',v_source.reverses_journal_id
 )::text,'UTF8')),'hex');
 v_key:='gl:accrual:'||v_source.id::text||':v1';
 -- If already posted, allow only exact idempotent replay. Do not mutate or
 -- silently "fix" the ledger when the underlying approved source differs.
 SELECT * INTO v_entry FROM public.financial_gl_entries e
 WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
   AND e.source_type='accrual_adjustment'
   AND e.source_id=v_source.id::text AND e.source_revision=1;
 IF FOUND THEN
   IF v_entry.source_fingerprint<>v_fingerprint
     OR v_entry.period<>v_source.period OR v_entry.operation_key<>v_key
     OR (SELECT count(*) FROM public.financial_gl_lines l
         WHERE l.entry_id=v_entry.id AND l.tenant_id=p_tenant_id AND l.site_id=p_site_id
         AND ((l.account_code=v_source.debit_account AND l.side='debit'
               AND l.amount=v_source.amount)
           OR (l.account_code=v_source.credit_account AND l.side='credit'
               AND l.amount=v_source.amount)))<>2
     OR (SELECT count(*) FROM public.financial_gl_lines l WHERE l.entry_id=v_entry.id)<>2
   THEN
     RAISE EXCEPTION 'GL_SOURCE_REPLAY_MISMATCH' USING ERRCODE='23505';
   END IF;
   RETURN jsonb_build_object('entryId',v_entry.id,'status','posted',
       'alreadyPosted',true,'sourceJournalId',v_source.id);
 END IF;
 IF EXISTS (SELECT 1 FROM public.financial_accrual_period_reviews r
   WHERE r.tenant_id=p_tenant_id AND r.site_id=p_site_id
     AND r.period=v_source.period AND r.status='locked') THEN
   RAISE EXCEPTION 'GL_SOURCE_PERIOD_LOCKED' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.sites s
   WHERE s.id=p_site_id AND s.tenant_id=p_tenant_id AND s.status<>'archived') THEN
   RAISE EXCEPTION 'GL_SITE_OUT_OF_SCOPE' USING ERRCODE='22023';
 END IF;
 v_original_entry_id:=NULL;
 IF v_source.reverses_journal_id IS NOT NULL THEN
   SELECT e.id INTO v_original_entry_id FROM public.financial_gl_entries e
   WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
     AND e.source_type='accrual_adjustment' AND e.source_revision=1
     AND e.source_id=v_source.reverses_journal_id::text;
   IF v_original_entry_id IS NULL THEN
     RAISE EXCEPTION 'GL_REVERSAL_SOURCE_NOT_POSTED' USING ERRCODE='22023';
   END IF;
 END IF;
 -- Canonical, tenant-scoped account catalog. A conflicting pre-existing code
 -- is a hard error; we never alter a chart of accounts silently.
 WITH specs(code,name,account_class,normal_side,is_contra) AS (
   VALUES
   ('1100','إيراد خدمة مستحق غير مفوتر','asset','debit',false),
   ('1190','مخصص ديون مشكوك في تحصيلها','asset','credit',true),
   ('1500','مجمع إهلاك الأصول الثابتة','asset','credit',true),
   ('2100','مصروفات والتزامات مستحقة','liability','credit',false),
   ('2200','إيراد خدمة مؤجل','liability','credit',false),
   ('4100','إيرادات خدمة الكهرباء','revenue','credit',false),
   ('5100','تكاليف تشغيل مستحقة','expense','debit',false),
   ('5300','مصروف إهلاك','expense','debit',false),
   ('5400','مصروف مخصص ديون','expense','debit',false),
   ('6100','مصروف غير تشغيلي','expense','debit',false)
 )
 INSERT INTO public.financial_gl_accounts
   (tenant_id,code,name,account_class,normal_side,is_contra)
 SELECT p_tenant_id,code,name,account_class,normal_side,is_contra
 FROM specs WHERE code IN (v_source.debit_account,v_source.credit_account)
 ON CONFLICT (tenant_id,code) DO NOTHING;
 SELECT count(*) INTO v_pair_count FROM public.financial_gl_accounts a
 WHERE a.tenant_id=p_tenant_id AND (
   (a.code=v_source.debit_account) OR (a.code=v_source.credit_account)
 );
 IF v_pair_count<>2 THEN
   RAISE EXCEPTION 'GL_UNSUPPORTED_ACCOUNT_CODE' USING ERRCODE='22023';
 END IF;
 IF EXISTS (
   SELECT 1 FROM public.financial_gl_accounts a
   WHERE a.tenant_id=p_tenant_id
     AND a.code IN (v_source.debit_account,v_source.credit_account)
     AND (a.account_class IS DISTINCT FROM CASE a.code
         WHEN '1100' THEN 'asset' WHEN '1190' THEN 'asset'
         WHEN '1500' THEN 'asset' WHEN '2100' THEN 'liability'
         WHEN '2200' THEN 'liability' WHEN '4100' THEN 'revenue'
         WHEN '5100' THEN 'expense' WHEN '5300' THEN 'expense'
         WHEN '5400' THEN 'expense' WHEN '6100' THEN 'expense'
         ELSE NULL END
       OR a.normal_side IS DISTINCT FROM CASE
         WHEN a.code IN ('1190','1500','2100','2200','4100')
           THEN 'credit' ELSE 'debit' END
       OR a.is_contra IS DISTINCT FROM (a.code IN ('1190','1500')))
 ) THEN
   RAISE EXCEPTION 'GL_ACCOUNT_CATALOG_CONFLICT' USING ERRCODE='23514';
 END IF;
 INSERT INTO public.financial_gl_entries
   (tenant_id,site_id,period,source_type,source_id,source_revision,
    operation_key,source_fingerprint,accounting_policy_version,
    posted_by_user_id,reverses_entry_id)
 VALUES (p_tenant_id,p_site_id,v_source.period,'accrual_adjustment',
    v_source.id::text,1,v_key,v_fingerprint,
    'accrual-approved-subledger-v1',v_source.approved_by_user_id,
    v_original_entry_id)
 RETURNING * INTO v_entry;
 INSERT INTO public.financial_gl_lines
   (entry_id,tenant_id,site_id,account_code,side,amount)
 VALUES
   (v_entry.id,p_tenant_id,p_site_id,v_source.debit_account,'debit',v_source.amount),
   (v_entry.id,p_tenant_id,p_site_id,v_source.credit_account,'credit',v_source.amount);
 -- The existing deferred GL balance constraint validates before commit.
 RETURN jsonb_build_object('entryId',v_entry.id,'status','posted',
       'alreadyPosted',false,'sourceJournalId',v_source.id);
END;
$post$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_post_accrual(bigint,bigint,bigint)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_post_accrual(bigint,bigint,bigint)
  TO service_role;
COMMENT ON FUNCTION public.powerhub_financial_gl_post_accrual(bigint,bigint,bigint)
 IS 'Atomic, source-derived GL projection of an APPROVED accrual journal, restricted to backend service_role; not final accounting recognition.';

-- Atomic approval boundary: both the accrual status change and the GL
-- projection are performed in ONE PostgreSQL function call / transaction.
-- No server-side two-RPC waterfall, which could leave a posted source without GL.
CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_post_and_gl(
 p_tenant_id bigint, p_site_id bigint, p_journal_id bigint, p_user_id bigint
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $boundary$
DECLARE v_approval jsonb; v_gl jsonb;
BEGIN
 IF p_user_id IS NULL OR p_user_id<=0 THEN
   RAISE EXCEPTION 'GL_APPROVER_REQUIRED' USING ERRCODE='22023';
 END IF;
 v_approval:=public.powerhub_financial_accrual_journal_post(
   p_tenant_id,p_site_id,p_journal_id,p_user_id);
 IF v_approval IS NULL OR v_approval->>'status'<>'posted' THEN
   RAISE EXCEPTION 'GL_APPROVAL_NOT_CONFIRMED' USING ERRCODE='22023';
 END IF;
 v_gl:=public.powerhub_financial_gl_post_accrual(
   p_tenant_id,p_site_id,p_journal_id);
 IF v_gl IS NULL OR v_gl->>'status'<>'posted' THEN
   RAISE EXCEPTION 'GL_POST_NOT_CONFIRMED' USING ERRCODE='22023';
 END IF;
 RETURN v_approval || jsonb_build_object(
   'glEntryId',(v_gl->>'entryId')::bigint,
   'glAlreadyPosted',(v_gl->>'alreadyPosted')::boolean,
   'sourceJournalId',p_journal_id
 );
END;
$boundary$;
REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_post_and_gl(bigint,bigint,bigint,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_post_and_gl(bigint,bigint,bigint,bigint)
 TO service_role;
COMMENT ON FUNCTION public.powerhub_financial_accrual_post_and_gl(bigint,bigint,bigint,bigint)
 IS 'Atomic accrual approval and balanced GL posting; both succeed or both roll back. Service-role server authorization required.';

NOTIFY pgrst,'reload schema';
