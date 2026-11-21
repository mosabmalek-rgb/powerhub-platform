-- B3.9.5 block orphan consolidation elimination headers and suppress approved totals if integrity fails.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_inter_site_posting_audit(p_tenant_id bigint, p_period text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 op record; src public.account_transactions%ROWTYPE; dst public.account_transactions%ROWTYPE;
 ca public.company_accounts%ROWTYPE; cb public.company_accounts%ROWTYPE;
 ea public.financial_gl_entries%ROWTYPE; eb public.financial_gl_entries%ROWTYPE;
 v_count bigint:=0;v_invalid bigint:=0;v_pending bigint:=0;v_matched bigint:=0;
 v_amount numeric:=0;v_cash_a text;v_cash_b text;v_period text;
 v_fp text;v_gl_count bigint;v_orphans bigint;v_orphan_eliminations bigint:=0;v_bad bigint;
 v_examples jsonb:='[]'::jsonb;v_matched_items jsonb:='[]'::jsonb;
 v_approved numeric:=0;v_drafts bigint:=0;v_reason text;
 v_elim public.financial_gl_inter_site_eliminations%ROWTYPE;
 v_cutoff timestamptz;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_period IS NULL
 OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 THEN RAISE EXCEPTION 'GL_B39_SCOPE_INVALID' USING ERRCODE='22023';END IF;
 v_cutoff:=(((p_period||'-01')::date+interval '1 month') AT TIME ZONE 'Asia/Gaza');
 FOR op IN SELECT * FROM public.company_account_movement_operations
  WHERE tenant_id=p_tenant_id AND operation_type='transfer'
   AND created_at<v_cutoff ORDER BY created_at,primary_transaction_id LOOP
   v_reason:=NULL;
   SELECT * INTO src FROM public.account_transactions t
   WHERE t.tenant_id=p_tenant_id AND t.id=op.primary_transaction_id;
   SELECT * INTO dst FROM public.account_transactions t
   WHERE t.tenant_id=p_tenant_id AND t.id=op.counterpart_transaction_id;
   -- This report only examines transfers spanning two distinct sites.
   -- Intra-site source transfers belong to B4, not B3 eliminations.
   IF src.id IS NOT NULL AND dst.id IS NOT NULL
      AND src.site_id IS NOT DISTINCT FROM dst.site_id THEN CONTINUE; END IF;
   v_count:=v_count+1;
   IF src.id IS NULL OR dst.id IS NULL
    OR src.site_id IS DISTINCT FROM op.site_id
    OR src.tenant_id IS DISTINCT FROM op.tenant_id
    OR dst.tenant_id IS DISTINCT FROM op.tenant_id
    OR src.account_id IS NOT DISTINCT FROM dst.account_id
    OR src.transaction_type<>'transfer_out' OR dst.transaction_type<>'transfer_in'
    OR src.amount IS DISTINCT FROM dst.amount OR src.amount<=0
    OR src.related_account_id IS DISTINCT FROM dst.account_id
    OR dst.related_account_id IS DISTINCT FROM src.account_id
    OR src.created_by_user_id IS DISTINCT FROM op.created_by_user_id
    OR dst.created_by_user_id IS DISTINCT FROM op.created_by_user_id
    OR src.description IS DISTINCT FROM dst.description
    OR NOT EXISTS(SELECT 1 FROM generate_series(0,6) gs(input_scale)
       WHERE op.payload_hash=md5(jsonb_build_object(
         'tenantId',p_tenant_id,'siteId',op.site_id,'userId',op.created_by_user_id,
         'fromAccountId',src.account_id,'toAccountId',dst.account_id,
         'amount',round(src.amount,gs.input_scale),
         'description',btrim(src.description))::text))
    OR dst.site_id IS NULL OR dst.site_id IS NOT DISTINCT FROM src.site_id
    OR src.occurred_at>=v_cutoff OR dst.occurred_at>=v_cutoff
    OR to_char(src.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM')
       IS DISTINCT FROM to_char(dst.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM')
   THEN v_reason:='INVALID_INTER_SITE_OPERATION'; END IF;
   IF v_reason IS NULL THEN
    SELECT * INTO ca FROM public.company_accounts a
     WHERE a.tenant_id=p_tenant_id AND a.id=src.account_id;
    SELECT * INTO cb FROM public.company_accounts a
     WHERE a.tenant_id=p_tenant_id AND a.id=dst.account_id;
    IF ca.id IS NULL OR cb.id IS NULL
       OR ca.is_active IS DISTINCT FROM true OR cb.is_active IS DISTINCT FROM true
       OR (SELECT count(*) FROM public.company_account_sites cs
        WHERE cs.tenant_id=p_tenant_id AND cs.account_id=ca.id)<>1
       OR (SELECT count(*) FROM public.company_account_sites cs
        WHERE cs.tenant_id=p_tenant_id AND cs.account_id=cb.id)<>1
       OR NOT EXISTS(SELECT 1 FROM public.company_account_sites cs
        WHERE cs.tenant_id=p_tenant_id AND cs.site_id=src.site_id AND cs.account_id=src.account_id)
       OR NOT EXISTS(SELECT 1 FROM public.company_account_sites cs
        WHERE cs.tenant_id=p_tenant_id AND cs.site_id=dst.site_id AND cs.account_id=dst.account_id)
       OR NOT EXISTS(SELECT 1 FROM public.sites ss WHERE ss.id=src.site_id AND ss.tenant_id=p_tenant_id AND ss.status='active')
       OR NOT EXISTS(SELECT 1 FROM public.sites ss WHERE ss.id=dst.site_id AND ss.tenant_id=p_tenant_id AND ss.status='active')
    THEN v_reason:='INVALID_INTER_SITE_ACCOUNT_MAPPING'; END IF;
   END IF;
   IF v_reason IS NOT NULL THEN
    v_invalid:=v_invalid+1;
   ELSE
    v_period:=to_char(src.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
    v_fp:=encode(extensions.digest(jsonb_build_object(
     'key',op.operation_key,'payloadHash',op.payload_hash,
     'sourceId',src.id,'destinationId',dst.id,
     'fromSite',src.site_id,'toSite',dst.site_id,
     'fromAccount',src.account_id,'toAccount',dst.account_id,
     'amount',src.amount,'period',v_period)::text,'sha256'),'hex');
    SELECT * INTO ea FROM public.financial_gl_entries e
     WHERE e.tenant_id=p_tenant_id AND e.site_id=src.site_id
      AND e.source_type='account_movement' AND e.source_id=src.id::text;
    SELECT * INTO eb FROM public.financial_gl_entries e
     WHERE e.tenant_id=p_tenant_id AND e.site_id=dst.site_id
      AND e.source_type='account_movement' AND e.source_id=dst.id::text;
    IF ea.id IS NULL AND eb.id IS NULL THEN
      v_pending:=v_pending+1;v_reason:='SOURCE_UNPOSTED_GL';
    ELSE
      v_cash_a:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
      v_cash_b:=CASE WHEN cb.account_type='cash' THEN '1010' ELSE '1020' END;
      IF ea.id IS NULL OR eb.id IS NULL
      OR ea.source_fingerprint<>v_fp OR eb.source_fingerprint<>v_fp
      OR ea.accounting_policy_version<>'inter-site-due-from-to-v1'
      OR eb.accounting_policy_version<>'inter-site-due-from-to-v1'
      OR ea.period<>v_period OR eb.period<>v_period
      OR ea.posted_by_user_id IS DISTINCT FROM eb.posted_by_user_id
      OR ea.posted_by_user_id IS NOT DISTINCT FROM op.created_by_user_id
      OR (SELECT count(*) FROM public.financial_gl_lines WHERE entry_id=ea.id)<>2
      OR (SELECT count(*) FROM public.financial_gl_lines WHERE entry_id=eb.id)<>2
      OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines WHERE entry_id=ea.id
          AND account_code='1350' AND side='debit' AND amount=src.amount)
      OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines WHERE entry_id=ea.id
          AND account_code=v_cash_a AND side='credit' AND amount=src.amount)
      OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines WHERE entry_id=eb.id
          AND account_code=v_cash_b AND side='debit' AND amount=src.amount)
      OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines WHERE entry_id=eb.id
          AND account_code='2350' AND side='credit' AND amount=src.amount)
      THEN v_reason:='GL_PAIR_MISSING_OR_MISMATCHED';v_invalid:=v_invalid+1;
      ELSE
        v_matched:=v_matched+1;v_amount:=v_amount+src.amount;
        SELECT * INTO v_elim FROM public.financial_gl_inter_site_eliminations
        WHERE tenant_id=p_tenant_id AND source_primary_id=src.id;
        IF v_elim.id IS NOT NULL THEN
          IF v_elim.status='approved'
          AND v_elim.amount=src.amount AND v_elim.period=v_period
          AND v_elim.from_gl_entry_id=ea.id AND v_elim.to_gl_entry_id=eb.id
          AND v_elim.source_fingerprint=v_fp
          AND (SELECT count(*) FROM public.financial_gl_inter_site_elimination_lines eli
             WHERE eli.elimination_id=v_elim.id AND eli.tenant_id=p_tenant_id) = 2
          AND EXISTS(SELECT 1 FROM public.financial_gl_inter_site_elimination_lines eli
             WHERE eli.elimination_id=v_elim.id AND eli.tenant_id=p_tenant_id
              AND eli.sequence_no=1 AND eli.account_code='2350' AND eli.side='debit' AND eli.amount=src.amount)
          AND EXISTS(SELECT 1 FROM public.financial_gl_inter_site_elimination_lines eli
             WHERE eli.elimination_id=v_elim.id AND eli.tenant_id=p_tenant_id
              AND eli.sequence_no=2 AND eli.account_code='1350' AND eli.side='credit' AND eli.amount=src.amount)
          THEN v_approved:=v_approved+src.amount;
          ELSIF v_elim.status='draft' THEN v_drafts:=v_drafts+1;
          ELSE v_invalid:=v_invalid+1;v_reason:='ELIMINATION_INTEGRITY_INVALID'; END IF;
        END IF;
        IF jsonb_array_length(v_matched_items)<20 THEN
          v_matched_items:=v_matched_items||jsonb_build_array(jsonb_build_object(
          'sourceId',src.id,'counterpartId',dst.id,'fromSiteId',src.site_id,
          'toSiteId',dst.site_id,'amount',src.amount,'fromEntryId',ea.id,
          'toEntryId',eb.id,'eliminationId',v_elim.id,
          'eliminationStatus',coalesce(v_elim.status,'not_prepared')));
        END IF;
      END IF;
    END IF;
   END IF;
   IF v_reason IS NOT NULL AND jsonb_array_length(v_examples)<20 THEN
     v_examples:=v_examples||jsonb_build_array(jsonb_build_object(
        'sourceId',op.primary_transaction_id,'counterpartId',op.counterpart_transaction_id,
        'fromSiteId',op.site_id,'toSiteId',dst.site_id,'amount',src.amount,
        'reason',v_reason));
   END IF;
 END LOOP;
 SELECT count(*) INTO v_orphans FROM public.financial_gl_entries e
 WHERE e.tenant_id=p_tenant_id AND e.period<=p_period
  AND e.accounting_policy_version='inter-site-due-from-to-v1'
  AND NOT EXISTS(SELECT 1 FROM public.company_account_movement_operations op2
   WHERE op2.tenant_id=e.tenant_id AND op2.operation_type='transfer'
   AND (op2.primary_transaction_id::text=e.source_id
        OR op2.counterpart_transaction_id::text=e.source_id));
 -- B3.9.5: an elimination may survive without its originating transfer or
 -- both site journals (e.g. privileged fixture data changes). Fail closed.
 SELECT count(*) INTO v_orphan_eliminations
 FROM public.financial_gl_inter_site_eliminations elim
 WHERE elim.tenant_id=p_tenant_id AND elim.period<=p_period
   AND (NOT EXISTS (
     SELECT 1 FROM public.company_account_movement_operations movement
     WHERE movement.tenant_id=elim.tenant_id
       AND movement.primary_transaction_id=elim.source_primary_id
       AND movement.operation_type='transfer')
   OR NOT EXISTS (
     SELECT 1 FROM public.financial_gl_entries gl_from
     WHERE gl_from.id=elim.from_gl_entry_id AND gl_from.tenant_id=elim.tenant_id
       AND gl_from.site_id=elim.from_site_id
       AND gl_from.source_type='account_movement'
       AND gl_from.source_id=elim.source_primary_id::text)
   OR NOT EXISTS (
     SELECT 1 FROM public.financial_gl_entries gl_to
     JOIN public.company_account_movement_operations movement
       ON movement.tenant_id=gl_to.tenant_id
       AND movement.primary_transaction_id=elim.source_primary_id
       AND movement.operation_type='transfer'
     WHERE gl_to.id=elim.to_gl_entry_id AND gl_to.tenant_id=elim.tenant_id
       AND gl_to.site_id=elim.to_site_id
       AND gl_to.source_type='account_movement'
       AND gl_to.source_id=movement.counterpart_transaction_id::text));
 RETURN jsonb_build_object(
   'tenantId',p_tenant_id,'period',p_period,
   'status',CASE WHEN v_invalid>0 OR v_orphans>0 OR v_orphan_eliminations>0 THEN 'BLOCKED_INTEGRITY'
     WHEN v_pending>0 THEN 'SOURCE_AWAITS_DUAL_SITE_GL'
     WHEN v_matched>0 THEN 'MATCHED_DUE_FROM_TO_PRELIMINARY_ONLY'
     ELSE 'NO_INTER_SITE_SOURCE_OBSERVED' END,
   'sourceCount',v_count,'matchedPairCount',v_matched,
   'pendingPairCount',v_pending,'invalidPairCount',v_invalid,
   'orphanGLEntryCount',v_orphans,'orphanEliminationCount',v_orphan_eliminations,
   'matchedDueFrom',v_amount,'matchedDueTo',v_amount,
   'eliminationPreviewAssetReduction',v_amount,
   'eliminationPreviewLiabilityReduction',v_amount,
   'eliminationPreviewNetPositionEffect',0,
   'mismatchExamples',v_examples,
   'matchedSources',v_matched_items,
   'approvedEliminationAmount',CASE WHEN v_invalid>0 OR v_orphans>0 OR v_orphan_eliminations>0 THEN NULL ELSE v_approved END,'draftEliminationCount',v_drafts,
   'approvedEliminationAssetReduction',CASE WHEN v_invalid>0 OR v_orphans>0 OR v_orphan_eliminations>0 THEN NULL ELSE v_approved END,
   'approvedEliminationLiabilityReduction',CASE WHEN v_invalid>0 OR v_orphans>0 OR v_orphan_eliminations>0 THEN NULL ELSE v_approved END,
   'accountingCertification','NOT_CERTIFIED',
   'isFinalFinancialAcceptance',false,
   'isConsolidatedFinancialStatements',false,
   'doesNotPostEliminationGL',true,
   'limitations',jsonb_build_array('ELIMINATION_REVIEW_NOT_FINAL_CERTIFICATION',
    'NO_CONSOLIDATED_TAX_MAPPING','NO_APPROVED_CONSOLIDATED_STATEMENTS'));
END;$function$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_inter_site_posting_audit(bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_inter_site_posting_audit(bigint,text) TO service_role;
