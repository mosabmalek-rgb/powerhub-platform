-- A5: reconcile approved accrual-adjustment GL entries with their immutable
-- authorization document, exact source hash, debit/credit lines, and reversal.
-- Forward-only. No change to posted GL, no backfill and no certification.
-- Replaces only the source-integrity function; 18000 coverage already calls it.
-- A4: fail-closed GL source integrity audit, with source evidence and actual GL lines.
-- No backfill, no client execute, no journal mutation.
-- Checks ALL posted through-period GL entries; only diagnostic samples are bounded.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_source_integrity(
 p_tenant_id bigint,p_site_id bigint,p_period text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $integrity$
DECLARE
 v_entry public.financial_gl_entries%ROWTYPE;
 v_invoice public.invoices%ROWTYPE;
 v_accrual public.financial_accrual_journals%ROWTYPE;
 v_accrual_original_entry_id bigint;
 v_invoice_gl public.financial_gl_entries%ROWTYPE;
 v_plan jsonb; v_invoice_plan jsonb;
 v_checked bigint:=0; v_drifted bigint:=0;
 v_invalid bigint:=0; v_unverified bigint:=0;
 v_samples jsonb:='[]'::jsonb;
 v_reason text; v_bad_lines boolean;
 v_invoice_id bigint; v_month date; v_last date;
 v_first_service date; v_last_service date;
 v_days bigint; v_net_minor bigint; v_through bigint; v_prior bigint;
 v_amount_minor bigint; v_amount numeric; v_hash text;
 v_line_count bigint; v_matching_lines bigint;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
    OR p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    OR NOT EXISTS (SELECT 1 FROM public.sites s
      WHERE s.id=p_site_id AND s.tenant_id=p_tenant_id AND s.status<>'archived')
 THEN RAISE EXCEPTION 'GL_INTEGRITY_INVALID_SCOPE' USING ERRCODE='22023'; END IF;
 FOR v_entry IN SELECT e.* FROM public.financial_gl_entries e
   WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
     AND e.period<=p_period
   ORDER BY e.id
 LOOP
   v_reason:=NULL;
   IF v_entry.source_type IN
      ('invoice','payment','expense','supplier_ledger',
       'stock_movement','payroll','payroll_payment') THEN
     v_checked:=v_checked+1;
     IF v_entry.source_id !~ '^[0-9]{1,18}$' OR v_entry.source_revision<>1 THEN
       v_reason:='INVALID_SOURCE_ID_OR_REVISION';
       v_invalid:=v_invalid+1;
     ELSE
       BEGIN
         v_plan:=public.powerhub_financial_gl_source_plan(
           p_tenant_id,p_site_id,v_entry.source_type,v_entry.source_id::bigint);
         SELECT
           EXISTS(
             SELECT x->>'code' AS code,x->>'side' AS side,
               (x->>'amount')::numeric AS amount,count(*) AS n
             FROM jsonb_array_elements(v_plan->'lines') x
             GROUP BY 1,2,3
             EXCEPT
             SELECT l.account_code,l.side,l.amount,count(*)
             FROM public.financial_gl_lines l WHERE l.entry_id=v_entry.id
             GROUP BY 1,2,3)
           OR EXISTS(
             SELECT l.account_code,l.side,l.amount,count(*)
             FROM public.financial_gl_lines l WHERE l.entry_id=v_entry.id
             GROUP BY 1,2,3
             EXCEPT
             SELECT x->>'code',x->>'side',(x->>'amount')::numeric,count(*)
             FROM jsonb_array_elements(v_plan->'lines') x GROUP BY 1,2,3)
         INTO v_bad_lines;
         IF v_entry.source_fingerprint IS DISTINCT FROM v_plan->>'sourceFingerprint'
           OR v_entry.period IS DISTINCT FROM v_plan->>'period'
           OR v_entry.accounting_policy_version IS DISTINCT FROM v_plan->>'policyVersion'
           OR v_entry.reverses_entry_id IS DISTINCT FROM
             (v_plan->>'reversesEntryId')::bigint
           OR v_entry.operation_key IS DISTINCT FROM
              'gl:source:'||v_entry.source_type||':'||v_entry.source_id||':v1'
           OR v_bad_lines THEN
           v_reason:='SOURCE_FINGERPRINT_OR_LINES_CHANGED';
           v_drifted:=v_drifted+1;
         END IF;
       EXCEPTION
         WHEN SQLSTATE '22023' OR SQLSTATE '23505' OR SQLSTATE '23514' THEN
           v_reason:='SOURCE_NOT_VERIFIABLE';
           v_invalid:=v_invalid+1;
       END;
     END IF;
   ELSIF v_entry.source_type='accrual_adjustment' THEN
     v_checked:=v_checked+1;
     IF v_entry.source_id !~ '^[0-9]{1,18}
     v_checked:=v_checked+1;
     IF v_entry.source_id !~ '^[0-9]{1,18}:[0-9]{4}-(0[1-9]|1[0-2])$'
        OR v_entry.source_revision<>1
        OR split_part(v_entry.source_id,':',2)<>v_entry.period THEN
       v_reason:='SERVICE_SOURCE_ID_INVALID';
       v_invalid:=v_invalid+1;
     ELSE
       BEGIN
         v_invoice_id:=split_part(v_entry.source_id,':',1)::bigint;
         SELECT * INTO v_invoice FROM public.invoices i
           WHERE i.id=v_invoice_id AND i.tenant_id=p_tenant_id
             AND i.site_id=p_site_id;
         IF NOT FOUND THEN
           RAISE EXCEPTION 'GL_INTEGRITY_INVOICE_MISSING' USING ERRCODE='22023';
         END IF;
         v_invoice_plan:=public.powerhub_financial_gl_source_plan(
           p_tenant_id,p_site_id,'invoice',v_invoice_id);
         SELECT * INTO v_invoice_gl FROM public.financial_gl_entries e
           WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
             AND e.source_type='invoice' AND e.source_id=v_invoice_id::text
             AND e.source_revision=1;
         IF NOT FOUND OR
            v_invoice_gl.source_fingerprint IS DISTINCT FROM
               v_invoice_plan->>'sourceFingerprint' OR
            v_invoice_gl.accounting_policy_version IS DISTINCT FROM
               'invoice-receivable-v1-defer-service' THEN
           RAISE EXCEPTION 'GL_INTEGRITY_INVOICE_NOT_DEFERRED'
             USING ERRCODE='22023';
         END IF;
         v_month:=(v_entry.period||'-01')::date;
         v_last:=(v_month+interval '1 month - 1 day')::date;
         v_first_service:=(v_invoice.cycle_start_at AT TIME ZONE 'Asia/Gaza')::date;
         v_last_service:=(v_invoice.cycle_end_at AT TIME ZONE 'Asia/Gaza')::date;
         v_days:=(v_last_service-v_first_service+1)::bigint;
         IF v_days NOT BETWEEN 1 AND 3660 OR v_first_service>v_last
            OR v_last_service<v_month OR v_first_service>v_last
         THEN RAISE EXCEPTION 'GL_INTEGRITY_SERVICE_PERIOD_INVALID'
           USING ERRCODE='22023'; END IF;
         v_net_minor:=((v_invoice.total_amount-v_invoice.tax_amount)*100)::bigint;
         v_through:=v_net_minor*((least(v_last_service,v_last)
           -v_first_service+1)::bigint)/v_days;
         v_prior:=v_net_minor*((greatest(v_first_service,v_month)
           -v_first_service)::bigint)/v_days;
         v_amount_minor:=v_through-v_prior;
         IF v_amount_minor<=0 THEN
           RAISE EXCEPTION 'GL_INTEGRITY_SERVICE_ALLOCATION_INVALID'
             USING ERRCODE='22023';
         END IF;
         v_amount:=v_amount_minor::numeric/100;
         v_hash:=encode(sha256(convert_to(jsonb_build_object(
           'invoice',v_invoice.id,'period',v_entry.period,
           'invoiceSourceHash',v_invoice_plan->>'sourceFingerprint',
           'minorUnits',v_amount_minor,
           'policy','gaza-invoice-service-calendar-days-v1'
         )::text,'UTF8')),'hex');
         SELECT count(*),count(*) FILTER (WHERE
           (l.account_code='2200' AND l.side='debit' AND l.amount=v_amount)
           OR (l.account_code='4100' AND l.side='credit' AND l.amount=v_amount))
           INTO v_line_count,v_matching_lines
         FROM public.financial_gl_lines l WHERE l.entry_id=v_entry.id;
         IF v_entry.source_fingerprint IS DISTINCT FROM v_hash
           OR v_entry.accounting_policy_version IS DISTINCT FROM
             'gaza-invoice-service-calendar-days-v1'
           OR v_entry.operation_key IS DISTINCT FROM
             'gl:service:'||v_entry.source_id||':v1'
           OR v_line_count<>2 OR v_matching_lines<>2
         THEN
           v_reason:='SERVICE_FINGERPRINT_OR_LINES_CHANGED';
           v_drifted:=v_drifted+1;
         END IF;
       EXCEPTION
         WHEN SQLSTATE '22023' OR SQLSTATE '23505' OR SQLSTATE '23514' THEN
           v_reason:='SERVICE_NOT_VERIFIABLE';
           v_invalid:=v_invalid+1;
       END;
     END IF;
   ELSIF v_entry.source_type='opening_balance' THEN
     v_checked:=v_checked+1;
     IF NOT EXISTS (
       SELECT 1 FROM public.financial_gl_opening_batches b
       WHERE b.tenant_id=p_tenant_id AND b.site_id=p_site_id
         AND b.id::text=v_entry.source_id AND b.status='posted'
         AND b.source_fingerprint=v_entry.source_fingerprint
     ) THEN
       v_reason:='OPENING_GL_SOURCE_MISMATCH';
       v_drifted:=v_drifted+1;
     END IF;
   ELSE
     -- A type not yet audited is never interpreted as a clean source.
     -- Until a matching source-specific verifier is installed, no posted
     -- type (including earlier accrual adjustments) can be certified clean.
     v_unverified:=v_unverified+1;
     v_reason:='GL_SOURCE_TYPE_NOT_AUDITED';
   END IF;
   IF v_reason IS NOT NULL AND jsonb_array_length(v_samples)<12 THEN
     v_samples:=v_samples||jsonb_build_array(jsonb_build_object(
       'type',v_entry.source_type,'sourceId',v_entry.source_id,
       'entryId',v_entry.id,'reason',v_reason));
   END IF;
 END LOOP;
 RETURN jsonb_build_object(
   'checkedEntries',v_checked,'driftedEntries',v_drifted,
   'invalidSources',v_invalid,'unauditedEntries',v_unverified,
   'isClean',v_drifted=0 AND v_invalid=0 AND v_unverified=0,
   'samples',v_samples,
   'sampleTruncated',v_drifted+v_invalid+v_unverified>jsonb_array_length(v_samples));
END;
$integrity$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_source_integrity(bigint,bigint,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_source_integrity(bigint,bigint,text)
  TO service_role;


 OR v_entry.source_revision<>1 THEN
       v_reason:='ACCRUAL_SOURCE_ID_OR_REVISION_INVALID';
       v_invalid:=v_invalid+1;
     ELSE
       SELECT * INTO v_accrual FROM public.financial_accrual_journals j
       WHERE j.id=v_entry.source_id::bigint
         AND j.tenant_id=p_tenant_id AND j.site_id=p_site_id;
       IF NOT FOUND OR v_accrual.status<>'posted'
          OR v_accrual.approved_by_user_id IS NULL
          OR v_accrual.created_by_user_id=v_accrual.approved_by_user_id
          OR v_accrual.approved_at IS NULL
          OR v_accrual.amount IS NULL OR v_accrual.amount<=0
          OR v_accrual.amount<>round(v_accrual.amount,2)
          OR v_accrual.debit_account=v_accrual.credit_account THEN
         v_reason:='ACCRUAL_NOT_APPROVED_OR_MISSING';
         v_invalid:=v_invalid+1;
       ELSE
         v_accrual_original_entry_id:=NULL;
         IF v_accrual.reverses_journal_id IS NOT NULL THEN
           SELECT o.id INTO v_accrual_original_entry_id
           FROM public.financial_gl_entries o
           WHERE o.tenant_id=p_tenant_id AND o.site_id=p_site_id
             AND o.source_type='accrual_adjustment'
             AND o.source_id=v_accrual.reverses_journal_id::text
             AND o.source_revision=1;
         END IF;
         v_hash:=encode(sha256(convert_to(jsonb_build_object(
            'tenantId',v_accrual.tenant_id,'siteId',v_accrual.site_id,
            'journalId',v_accrual.id,'period',v_accrual.period,
            'debit',v_accrual.debit_account,'credit',v_accrual.credit_account,
            'amount',v_accrual.amount,'reason',v_accrual.reason,
            'createdBy',v_accrual.created_by_user_id,
            'approvedBy',v_accrual.approved_by_user_id,
            'approvedAt',v_accrual.approved_at,
            'reverses',v_accrual.reverses_journal_id
         )::text,'UTF8')),'hex');
         SELECT count(*),count(*) FILTER(WHERE
            (l.account_code=v_accrual.debit_account
              AND l.side='debit' AND l.amount=v_accrual.amount)
            OR
            (l.account_code=v_accrual.credit_account
              AND l.side='credit' AND l.amount=v_accrual.amount))
           INTO v_line_count,v_matching_lines
         FROM public.financial_gl_lines l WHERE l.entry_id=v_entry.id;
         IF v_accrual.reverses_journal_id IS NOT NULL
           AND v_accrual_original_entry_id IS NULL THEN
           v_reason:='ACCRUAL_REVERSAL_ORIGINAL_GL_MISSING';
           v_invalid:=v_invalid+1;
         ELSIF v_entry.source_fingerprint IS DISTINCT FROM v_hash
           OR v_entry.period IS DISTINCT FROM v_accrual.period
           OR v_entry.operation_key IS DISTINCT FROM
              'gl:accrual:'||v_accrual.id||':v1'
           OR v_entry.accounting_policy_version IS DISTINCT FROM
              'accrual-approved-subledger-v1'
           OR v_entry.posted_by_user_id IS DISTINCT FROM
              v_accrual.approved_by_user_id
           OR v_entry.reverses_entry_id IS DISTINCT FROM
              v_accrual_original_entry_id
           OR v_line_count<>2 OR v_matching_lines<>2 THEN
           v_reason:='ACCRUAL_APPROVAL_FINGERPRINT_OR_LINES_CHANGED';
           v_drifted:=v_drifted+1;
         END IF;
       END IF;
     END IF;
   ELSIF v_entry.source_type='service_recognition' THEN
     v_checked:=v_checked+1;
     IF v_entry.source_id !~ '^[0-9]{1,18}:[0-9]{4}-(0[1-9]|1[0-2])$'
        OR v_entry.source_revision<>1
        OR split_part(v_entry.source_id,':',2)<>v_entry.period THEN
       v_reason:='SERVICE_SOURCE_ID_INVALID';
       v_invalid:=v_invalid+1;
     ELSE
       BEGIN
         v_invoice_id:=split_part(v_entry.source_id,':',1)::bigint;
         SELECT * INTO v_invoice FROM public.invoices i
           WHERE i.id=v_invoice_id AND i.tenant_id=p_tenant_id
             AND i.site_id=p_site_id;
         IF NOT FOUND THEN
           RAISE EXCEPTION 'GL_INTEGRITY_INVOICE_MISSING' USING ERRCODE='22023';
         END IF;
         v_invoice_plan:=public.powerhub_financial_gl_source_plan(
           p_tenant_id,p_site_id,'invoice',v_invoice_id);
         SELECT * INTO v_invoice_gl FROM public.financial_gl_entries e
           WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
             AND e.source_type='invoice' AND e.source_id=v_invoice_id::text
             AND e.source_revision=1;
         IF NOT FOUND OR
            v_invoice_gl.source_fingerprint IS DISTINCT FROM
               v_invoice_plan->>'sourceFingerprint' OR
            v_invoice_gl.accounting_policy_version IS DISTINCT FROM
               'invoice-receivable-v1-defer-service' THEN
           RAISE EXCEPTION 'GL_INTEGRITY_INVOICE_NOT_DEFERRED'
             USING ERRCODE='22023';
         END IF;
         v_month:=(v_entry.period||'-01')::date;
         v_last:=(v_month+interval '1 month - 1 day')::date;
         v_first_service:=(v_invoice.cycle_start_at AT TIME ZONE 'Asia/Gaza')::date;
         v_last_service:=(v_invoice.cycle_end_at AT TIME ZONE 'Asia/Gaza')::date;
         v_days:=(v_last_service-v_first_service+1)::bigint;
         IF v_days NOT BETWEEN 1 AND 3660 OR v_first_service>v_last
            OR v_last_service<v_month OR v_first_service>v_last
         THEN RAISE EXCEPTION 'GL_INTEGRITY_SERVICE_PERIOD_INVALID'
           USING ERRCODE='22023'; END IF;
         v_net_minor:=((v_invoice.total_amount-v_invoice.tax_amount)*100)::bigint;
         v_through:=v_net_minor*((least(v_last_service,v_last)
           -v_first_service+1)::bigint)/v_days;
         v_prior:=v_net_minor*((greatest(v_first_service,v_month)
           -v_first_service)::bigint)/v_days;
         v_amount_minor:=v_through-v_prior;
         IF v_amount_minor<=0 THEN
           RAISE EXCEPTION 'GL_INTEGRITY_SERVICE_ALLOCATION_INVALID'
             USING ERRCODE='22023';
         END IF;
         v_amount:=v_amount_minor::numeric/100;
         v_hash:=encode(sha256(convert_to(jsonb_build_object(
           'invoice',v_invoice.id,'period',v_entry.period,
           'invoiceSourceHash',v_invoice_plan->>'sourceFingerprint',
           'minorUnits',v_amount_minor,
           'policy','gaza-invoice-service-calendar-days-v1'
         )::text,'UTF8')),'hex');
         SELECT count(*),count(*) FILTER (WHERE
           (l.account_code='2200' AND l.side='debit' AND l.amount=v_amount)
           OR (l.account_code='4100' AND l.side='credit' AND l.amount=v_amount))
           INTO v_line_count,v_matching_lines
         FROM public.financial_gl_lines l WHERE l.entry_id=v_entry.id;
         IF v_entry.source_fingerprint IS DISTINCT FROM v_hash
           OR v_entry.accounting_policy_version IS DISTINCT FROM
             'gaza-invoice-service-calendar-days-v1'
           OR v_entry.operation_key IS DISTINCT FROM
             'gl:service:'||v_entry.source_id||':v1'
           OR v_line_count<>2 OR v_matching_lines<>2
         THEN
           v_reason:='SERVICE_FINGERPRINT_OR_LINES_CHANGED';
           v_drifted:=v_drifted+1;
         END IF;
       EXCEPTION
         WHEN SQLSTATE '22023' OR SQLSTATE '23505' OR SQLSTATE '23514' THEN
           v_reason:='SERVICE_NOT_VERIFIABLE';
           v_invalid:=v_invalid+1;
       END;
     END IF;
   ELSIF v_entry.source_type='opening_balance' THEN
     v_checked:=v_checked+1;
     IF NOT EXISTS (
       SELECT 1 FROM public.financial_gl_opening_batches b
       WHERE b.tenant_id=p_tenant_id AND b.site_id=p_site_id
         AND b.id::text=v_entry.source_id AND b.status='posted'
         AND b.source_fingerprint=v_entry.source_fingerprint
     ) THEN
       v_reason:='OPENING_GL_SOURCE_MISMATCH';
       v_drifted:=v_drifted+1;
     END IF;
   ELSE
     -- A type not yet audited is never interpreted as a clean source.
     -- Until a matching source-specific verifier is installed, no posted
     -- type (including earlier accrual adjustments) can be certified clean.
     v_unverified:=v_unverified+1;
     v_reason:='GL_SOURCE_TYPE_NOT_AUDITED';
   END IF;
   IF v_reason IS NOT NULL AND jsonb_array_length(v_samples)<12 THEN
     v_samples:=v_samples||jsonb_build_array(jsonb_build_object(
       'type',v_entry.source_type,'sourceId',v_entry.source_id,
       'entryId',v_entry.id,'reason',v_reason));
   END IF;
 END LOOP;
 RETURN jsonb_build_object(
   'checkedEntries',v_checked,'driftedEntries',v_drifted,
   'invalidSources',v_invalid,'unauditedEntries',v_unverified,
   'isClean',v_drifted=0 AND v_invalid=0 AND v_unverified=0,
   'samples',v_samples,
   'sampleTruncated',v_drifted+v_invalid+v_unverified>jsonb_array_length(v_samples));
END;
$integrity$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_source_integrity(bigint,bigint,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_source_integrity(bigint,bigint,text)
  TO service_role;



NOTIFY pgrst,'reload schema';
