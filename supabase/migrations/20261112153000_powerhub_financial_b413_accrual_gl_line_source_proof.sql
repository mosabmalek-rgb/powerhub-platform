-- B4.13: independent source-to-GL line binding for both halves of an accrual reversal.
-- Keep existing service-role-only ACL unchanged; function remains SECURITY INVOKER and STABLE.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_reversal_source_proof(
  p_tenant_id bigint,p_site_id bigint,p_original_id bigint,p_reversal_id bigint)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $proof$
DECLARE
 o public.financial_gl_entries%ROWTYPE;
 r public.financial_gl_entries%ROWTYPE;
 a public.financial_accrual_journals%ROWTYPE;
 b public.financial_accrual_journals%ROWTYPE;
 n_original integer; n_reversal integer; n_linked integer; has_diff boolean;
 sha_original text; sha_reversal text;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
    OR p_original_id IS NULL OR p_original_id<=0 OR p_reversal_id IS NULL
    OR p_reversal_id<=0 OR p_original_id=p_reversal_id
 THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
 SELECT * INTO o FROM public.financial_gl_entries
   WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND id=p_original_id;
 SELECT * INTO r FROM public.financial_gl_entries
   WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND id=p_reversal_id;
 IF o.id IS NULL OR r.id IS NULL OR r.reverses_entry_id IS DISTINCT FROM o.id
   OR o.reverses_entry_id IS NOT NULL OR r.period<o.period
   OR o.source_fingerprint !~ '^[0-9a-f]{64}$'
   OR r.source_fingerprint !~ '^[0-9a-f]{64}$'
   OR o.posted_at IS NULL OR r.posted_at IS NULL
 THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
 SELECT count(*) INTO n_linked FROM public.financial_gl_entries
   WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND reverses_entry_id=o.id;
 IF n_linked<>1 THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
 SELECT count(*) INTO n_original FROM public.financial_gl_lines
   WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND entry_id=o.id;
 SELECT count(*) INTO n_reversal FROM public.financial_gl_lines
   WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND entry_id=r.id;
 IF n_original<2 OR n_original<>n_reversal THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
 WITH original_group AS (
   SELECT account_code,side,amount,count(*) AS n
   FROM public.financial_gl_lines
   WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND entry_id=o.id
   GROUP BY account_code,side,amount
 ), inverse_group AS (
   SELECT account_code,
     CASE side WHEN 'debit' THEN 'credit' ELSE 'debit' END AS side,
     amount,count(*) AS n
   FROM public.financial_gl_lines
   WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND entry_id=r.id
   GROUP BY account_code,side,amount
 )
 SELECT EXISTS (
   SELECT 1 FROM (
     (SELECT account_code,side,amount,n FROM original_group
      EXCEPT SELECT account_code,side,amount,n FROM inverse_group)
     UNION ALL
     (SELECT account_code,side,amount,n FROM inverse_group
      EXCEPT SELECT account_code,side,amount,n FROM original_group)
   ) differences
 ) INTO has_diff;
 IF has_diff OR EXISTS (
    SELECT 1 FROM public.financial_gl_lines
    WHERE entry_id IN (o.id,r.id) AND tenant_id=p_tenant_id
      AND site_id=p_site_id AND (amount<=0 OR side NOT IN ('debit','credit'))
 ) THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
 IF o.source_type='accrual_adjustment' OR r.source_type='accrual_adjustment' THEN
   IF o.source_type<>'accrual_adjustment'
      OR r.source_type<>'accrual_adjustment'
      OR o.accounting_policy_version<>'accrual-approved-subledger-v1'
      OR r.accounting_policy_version<>'accrual-approved-subledger-v1'
   THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
   SELECT * INTO a FROM public.financial_accrual_journals
     WHERE tenant_id=p_tenant_id AND site_id=p_site_id
       AND id::text=o.source_id;
   SELECT * INTO b FROM public.financial_accrual_journals
     WHERE tenant_id=p_tenant_id AND site_id=p_site_id
       AND id::text=r.source_id;
   IF a.id IS NULL OR b.id IS NULL
     OR a.status<>'posted' OR b.status<>'posted'
     OR a.reverses_journal_id IS NOT NULL
     OR b.reverses_journal_id IS DISTINCT FROM a.id
     OR a.period<>o.period OR b.period<>r.period
     OR a.amount<=0 OR b.amount<>a.amount
     OR a.amount<>round(a.amount,2)
     OR b.amount<>round(b.amount,2)
     OR a.debit_account<>b.credit_account
     OR a.credit_account<>b.debit_account
     OR a.approved_by_user_id IS NULL OR b.approved_by_user_id IS NULL
     OR a.created_by_user_id=a.approved_by_user_id
     OR b.created_by_user_id=b.approved_by_user_id
     OR a.approved_at IS NULL OR b.approved_at IS NULL
     OR o.posted_by_user_id IS DISTINCT FROM a.approved_by_user_id
     OR r.posted_by_user_id IS DISTINCT FROM b.approved_by_user_id
   THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
   -- Source fingerprint alone cannot certify posted GL lines: both original and
   -- reversal must agree with their own independently approved accrual journal.
   IF n_original<>2 OR n_reversal<>2
      OR a.debit_account=a.credit_account OR b.debit_account=b.credit_account
      OR NOT EXISTS (
        SELECT 1 FROM public.financial_gl_lines l WHERE l.tenant_id=p_tenant_id
          AND l.site_id=p_site_id AND l.entry_id=o.id
          AND l.account_code=a.debit_account AND l.side='debit' AND l.amount=a.amount)
      OR NOT EXISTS (
        SELECT 1 FROM public.financial_gl_lines l WHERE l.tenant_id=p_tenant_id
          AND l.site_id=p_site_id AND l.entry_id=o.id
          AND l.account_code=a.credit_account AND l.side='credit' AND l.amount=a.amount)
      OR NOT EXISTS (
        SELECT 1 FROM public.financial_gl_lines l WHERE l.tenant_id=p_tenant_id
          AND l.site_id=p_site_id AND l.entry_id=r.id
          AND l.account_code=b.debit_account AND l.side='debit' AND l.amount=b.amount)
      OR NOT EXISTS (
        SELECT 1 FROM public.financial_gl_lines l WHERE l.tenant_id=p_tenant_id
          AND l.site_id=p_site_id AND l.entry_id=r.id
          AND l.account_code=b.credit_account AND l.side='credit' AND l.amount=b.amount)
   THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
   sha_original:=encode(sha256(convert_to(jsonb_build_object(
     'tenantId',a.tenant_id,'siteId',a.site_id,'journalId',a.id,
     'period',a.period,'debit',a.debit_account,'credit',a.credit_account,
     'amount',a.amount,'reason',a.reason,'createdBy',a.created_by_user_id,
     'approvedBy',a.approved_by_user_id,'approvedAt',a.approved_at,
     'reverses',a.reverses_journal_id
   )::text,'UTF8')),'hex');
   sha_reversal:=encode(sha256(convert_to(jsonb_build_object(
     'tenantId',b.tenant_id,'siteId',b.site_id,'journalId',b.id,
     'period',b.period,'debit',b.debit_account,'credit',b.credit_account,
     'amount',b.amount,'reason',b.reason,'createdBy',b.created_by_user_id,
     'approvedBy',b.approved_by_user_id,'approvedAt',b.approved_at,
     'reverses',b.reverses_journal_id
   )::text,'UTF8')),'hex');
   IF sha_original IS DISTINCT FROM o.source_fingerprint
      OR sha_reversal IS DISTINCT FROM r.source_fingerprint
   THEN RETURN 'BLOCKED_INTEGRITY'; END IF;
   RETURN 'SOURCE_BACKED_REVERSAL_VALID';
 END IF;
 RETURN 'GL_INVERSE_ONLY_SOURCE_UNATTESTED';
END;
$proof$;
