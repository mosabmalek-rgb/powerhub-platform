-- B4.12: fail-closed reversal counterpart provenance; report remains read-only and NOT_CERTIFIED.

-- B4.12: independent evidence check for an actual GL reversal pair.
-- Never implies that an undocumented opening has been independently attested.
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
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_reversal_source_proof(bigint,bigint,bigint,bigint)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_reversal_source_proof(bigint,bigint,bigint,bigint)
  TO service_role;

-- B4.11: server-only, source-first correction readiness report. Never posts or approves corrections.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_correction_readiness(p_tenant_id bigint, p_site_id bigint, p_period text, p_limit integer DEFAULT 25, p_before_entry_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE e public.financial_gl_entries%ROWTYPE;
 j public.financial_accrual_journals%ROWTYPE;
 v_rev_source public.financial_accrual_journals%ROWTYPE;
 v_reversal_entry bigint;
 v_valid boolean;
 v_has_more boolean:=false;
 v_total integer:=0;
 v_items jsonb:='[]'::jsonb;
 v_status text;
 v_reason text;
 v_source_sha text;
 v_next bigint;
 v_reverse_count integer;
 v_reverse_proof text;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0
 OR p_site_id IS NULL OR p_site_id<=0
 OR p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50
 OR (p_before_entry_id IS NOT NULL AND p_before_entry_id<=0)
 OR NOT EXISTS(SELECT 1 FROM public.sites s WHERE s.tenant_id=p_tenant_id
   AND s.id=p_site_id AND s.status<>'archived')
 THEN RAISE EXCEPTION 'GL_B411_CORRECTION_SCOPE_INVALID' USING ERRCODE='22023'; END IF;
 FOR e IN SELECT * FROM public.financial_gl_entries x
 WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id AND x.period=p_period
 AND (p_before_entry_id IS NULL OR x.id<p_before_entry_id)
 ORDER BY x.id DESC LIMIT p_limit+1 LOOP
   IF v_total>=p_limit THEN v_has_more:=true;EXIT;END IF;
   v_total:=v_total+1;
   v_next:=e.id;
   v_status:='REQUIRES_SOURCE_SPECIFIC_CORRECTION';
   v_reason:='Operational source must be corrected and independently authorized first';
   v_reversal_entry:=NULL;
   SELECT count(*),min(reverse.id) INTO v_reverse_count,v_reversal_entry
   FROM public.financial_gl_entries reverse
   WHERE reverse.tenant_id=e.tenant_id AND reverse.site_id=e.site_id
   AND reverse.reverses_entry_id=e.id;
   IF e.reverses_entry_id IS NOT NULL THEN
     v_reverse_proof:=public.powerhub_financial_gl_reversal_source_proof(
       e.tenant_id,e.site_id,e.reverses_entry_id,e.id);
     IF v_reverse_proof='SOURCE_BACKED_REVERSAL_VALID' THEN
       v_status:='REVERSAL_ENTRY_IMMUTABLE';
       v_reason:='Verified source-backed reversal; cannot be reversed generically';
     ELSIF v_reverse_proof='GL_INVERSE_ONLY_SOURCE_UNATTESTED' THEN
       v_status:='REVERSAL_ENTRY_SOURCE_REVIEW_REQUIRED';
       v_reason:='Inverse GL lines match, but independent source approval is unverified';
     ELSE
       v_status:='EXISTING_REVERSAL_INTEGRITY_BLOCKED';
       v_reason:='Reversal GL pair or linked source fails independent integrity proof';
     END IF;
   ELSIF v_reverse_count>0 THEN
     v_reverse_proof:=CASE WHEN v_reverse_count=1 THEN
       public.powerhub_financial_gl_reversal_source_proof(
         e.tenant_id,e.site_id,e.id,v_reversal_entry)
       ELSE 'BLOCKED_INTEGRITY' END;
     IF v_reverse_proof='SOURCE_BACKED_REVERSAL_VALID' THEN
       v_status:='ALREADY_REVERSED';
       v_reason:='One independently verified source-backed GL reversal exists';
     ELSIF v_reverse_proof='GL_INVERSE_ONLY_SOURCE_UNATTESTED' THEN
       v_status:='EXISTING_REVERSAL_SOURCE_REVIEW_REQUIRED';
       v_reason:='Reverse GL lines match but underlying source authorization is unverified';
     ELSE
       v_status:='EXISTING_REVERSAL_INTEGRITY_BLOCKED';
       v_reason:='Reversal count, counterpart GL lines or source evidence is invalid';
     END IF;
   ELSIF e.source_type='opening_balance' THEN
     v_status:='OPENING_DOCUMENTARY_EVIDENCE_REQUIRED';
     v_reason:='Original opening needs independently attested source evidence';
   ELSIF e.source_type='correction' THEN
     v_status:='CORRECTION_REVIEW_REQUIRED';
     v_reason:='Standalone correction entries cannot be reversed generically';
   ELSIF e.source_type='accrual_adjustment' THEN
     SELECT * INTO j FROM public.financial_accrual_journals aj
      WHERE aj.tenant_id=e.tenant_id AND aj.site_id=e.site_id
      AND aj.id::text=e.source_id;
     v_valid:=j.id IS NOT NULL AND j.status='posted'
       AND j.period=e.period AND j.reverses_journal_id IS NULL
       AND j.amount>0 AND j.amount=round(j.amount,2)
       AND j.debit_account<>j.credit_account
       AND j.approved_by_user_id IS NOT NULL
       AND j.approved_by_user_id<>j.created_by_user_id
       AND j.approved_at IS NOT NULL
       AND e.posted_by_user_id=j.approved_by_user_id
       AND e.accounting_policy_version='accrual-approved-subledger-v1'
       AND (SELECT count(*) FROM public.financial_gl_lines l
             WHERE l.entry_id=e.id AND l.tenant_id=e.tenant_id
               AND l.site_id=e.site_id)=2
       AND EXISTS(SELECT 1 FROM public.financial_gl_lines l
             WHERE l.entry_id=e.id AND l.tenant_id=e.tenant_id
             AND l.site_id=e.site_id AND l.account_code=j.debit_account
             AND l.side='debit' AND l.amount=j.amount)
       AND EXISTS(SELECT 1 FROM public.financial_gl_lines l
             WHERE l.entry_id=e.id AND l.tenant_id=e.tenant_id
             AND l.site_id=e.site_id AND l.account_code=j.credit_account
             AND l.side='credit' AND l.amount=j.amount);
     IF v_valid THEN
       v_source_sha:=encode(sha256(convert_to(jsonb_build_object(
         'tenantId',j.tenant_id,'siteId',j.site_id,
         'journalId',j.id,'period',j.period,
         'debit',j.debit_account,'credit',j.credit_account,
         'amount',j.amount,'reason',j.reason,
         'createdBy',j.created_by_user_id,
         'approvedBy',j.approved_by_user_id,
         'approvedAt',j.approved_at,
         'reverses',j.reverses_journal_id
       )::text,'UTF8')),'hex');
       v_valid:=v_source_sha=e.source_fingerprint;
     END IF;
     IF NOT v_valid THEN
       v_status:='ACCRUAL_SOURCE_OR_GL_INTEGRITY_BLOCKED';
       v_reason:='Posted GL and original independently approved source do not match';
     ELSE
       SELECT * INTO v_rev_source FROM public.financial_accrual_journals rev
       WHERE rev.tenant_id=e.tenant_id AND rev.site_id=e.site_id
         AND rev.reverses_journal_id=j.id AND rev.status<>'void'
       ORDER BY rev.id DESC LIMIT 1;
       IF v_rev_source.id IS NOT NULL THEN
         v_status:='ACCRUAL_SOURCE_REVERSAL_PENDING';
         v_reason:='A source reversal already exists; inspect its approval and GL posting instead';
       ELSE
         v_status:='ACCRUAL_SOURCE_REVERSAL_AVAILABLE';
         v_reason:='Use the existing accrual source reversal, independent approval, then GL posting workflow';
       END IF;
     END IF;
   END IF;
   v_items:=v_items||jsonb_build_array(jsonb_build_object(
    'entryId',e.id,'period',e.period,
    'sourceType',e.source_type,'sourceId',e.source_id,
    'reversesEntryId',e.reverses_entry_id,
    'existingReversalEntryId',v_reversal_entry,
    'status',v_status,'reasonCode',v_status,
    'canReverseGLDirectly',false,
    'canPrepareAccrualSourceReversal',v_status='ACCRUAL_SOURCE_REVERSAL_AVAILABLE',
    'accountingCertification','NOT_CERTIFIED'));
 END LOOP;
 RETURN jsonb_build_object(
   'tenantId',p_tenant_id,'siteId',p_site_id,'period',p_period,
   'items',v_items,'returnedCount',v_total,'hasMore',v_has_more,
   'nextBeforeEntryId',CASE WHEN v_has_more THEN v_next ELSE NULL END,
   'glOnlyReversalAllowed',false,
   'isFinalFinancialAcceptance',false,
   'accountingCertification','NOT_CERTIFIED');
END;$function$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_correction_readiness(bigint,bigint,text,integer,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_correction_readiness(bigint,bigint,text,integer,bigint) TO service_role;
