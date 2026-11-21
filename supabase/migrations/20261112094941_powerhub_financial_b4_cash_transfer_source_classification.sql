-- B4.7 repeatable replacement. Both migration versions were registered on Staging;
-- this file is idempotent, maintaining the exact final function definition.
-- Source transactions transfer_out/in affect operational balances but
-- cannot be accepted without corresponding GL posting.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_subledger_reconciliation(p_tenant_id bigint, p_site_id bigint, p_period text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 v_cutoff timestamptz;
 g_cash numeric:=0;g_wallet numeric:=0;g_ar numeric:=0;g_ap numeric:=0;g_stock numeric:=0;
 s_cash numeric:=0;s_wallet numeric:=0;s_ar numeric:=0;s_ap numeric:=0;s_stock numeric:=0;
 v_invoice_total numeric:=0;v_invoice_current numeric:=0;v_invoice_paid numeric:=0;v_invoice_credits numeric:=0;
 v_invoice_invalid bigint:=0;v_invoice_changed bigint:=0;v_later_payments bigint:=0;
 v_stock_unknown bigint:=0;v_stock_uncosted bigint:=0;
 v_cash_unknown bigint:=0;v_cash_openings bigint:=0;v_cash_transfer_movements bigint:=0;
 v_rows jsonb; v_bad bigint; v_mismatch bigint; v_gl_entries bigint;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
 OR p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 OR NOT EXISTS(SELECT 1 FROM public.sites WHERE tenant_id=p_tenant_id AND id=p_site_id AND status<>'archived')
 THEN RAISE EXCEPTION 'GL_B4_INVALID_SCOPE' USING ERRCODE='22023'; END IF;
 v_cutoff:=(((p_period||'-01')::date+interval '1 month')::timestamp AT TIME ZONE 'Asia/Gaza');
 SELECT count(*) INTO v_gl_entries FROM public.financial_gl_entries
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND period<=p_period;
 SELECT coalesce(sum(CASE WHEN l.account_code='1010' THEN (CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END) ELSE 0 END),0),
 coalesce(sum(CASE WHEN l.account_code='1020' THEN (CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END) ELSE 0 END),0),
 coalesce(sum(CASE WHEN l.account_code='1200' THEN (CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END) ELSE 0 END),0),
 coalesce(sum(CASE WHEN l.account_code='2300' THEN (CASE WHEN l.side='credit' THEN l.amount ELSE -l.amount END) ELSE 0 END),0),
 coalesce(sum(CASE WHEN l.account_code='1300' THEN (CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END) ELSE 0 END),0)
 INTO g_cash,g_wallet,g_ar,g_ap,g_stock
 FROM public.financial_gl_entries e JOIN public.financial_gl_lines l
 ON l.entry_id=e.id AND l.tenant_id=e.tenant_id AND l.site_id=e.site_id
 WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id AND e.period<=p_period
 AND l.account_code IN ('1010','1020','1200','2300','1300');
 -- Receivables are independently reconstructed from issued invoices minus completed payments.
 -- Current invoice balance_due is checked for drift; retrospective mutations block certification.
 SELECT coalesce(sum(i.total_amount),0),coalesce(sum(i.balance_due),0),
 count(*) FILTER(WHERE i.status IN ('cancelled','void','voided')),
 count(*) FILTER(WHERE i.updated_at>=v_cutoff),
 coalesce(sum(i.credit_applied_amount),0)
 INTO v_invoice_total,v_invoice_current,v_invoice_invalid,v_invoice_changed,v_invoice_credits
 FROM public.invoices i WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id
 AND i.issue_date<v_cutoff;
 SELECT coalesce(sum(p.invoice_applied_amount),0) INTO v_invoice_paid
 FROM public.payments p JOIN public.invoices i
 ON i.id=p.invoice_id AND i.tenant_id=p.tenant_id AND i.site_id=p.site_id
 WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id
 AND i.issue_date<v_cutoff AND p.paid_at<v_cutoff AND p.status='completed';
 SELECT count(*) INTO v_later_payments FROM public.payments p
 JOIN public.invoices i ON i.id=p.invoice_id AND i.tenant_id=p.tenant_id AND i.site_id=p.site_id
 WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id AND i.issue_date<v_cutoff
 AND p.paid_at>=v_cutoff AND p.status='completed';
 s_ar:=v_invoice_total-v_invoice_paid-v_invoice_credits;
 SELECT coalesce(sum(credit_amount-debit_amount),0) INTO s_ap
 FROM public.supplier_ledger_entries
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND occurred_at<v_cutoff;
 SELECT coalesce(sum(CASE
 WHEN movement_type IN ('purchase_receipt','adjustment_in','transfer_in') THEN total_cost_amount
 WHEN movement_type IN ('issue','supplier_return','adjustment_out','transfer_out') THEN -total_cost_amount
 ELSE 0 END),0),
 count(*) FILTER(WHERE movement_type NOT IN
 ('purchase_receipt','adjustment_in','transfer_in','issue','supplier_return','adjustment_out','transfer_out')),
 count(*) FILTER(WHERE total_cost_amount IS NULL)
 INTO s_stock,v_stock_unknown,v_stock_uncosted
 FROM public.inventory_stock_movements
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND occurred_at<v_cutoff;
 -- Company account opening balances are tenant-wide and cannot be assigned to a site.
 SELECT count(*) INTO v_cash_openings FROM public.company_accounts
 WHERE tenant_id=p_tenant_id AND opening_balance<>0;
 SELECT coalesce(sum(CASE WHEN a.account_type='cash'
 THEN (CASE WHEN t.transaction_type IN ('collection','transfer_in') THEN t.amount WHEN t.transaction_type IN ('withdrawal','transfer_out') THEN -t.amount ELSE 0 END)
 ELSE 0 END),0),
 coalesce(sum(CASE WHEN a.account_type<>'cash'
 THEN (CASE WHEN t.transaction_type IN ('collection','transfer_in') THEN t.amount WHEN t.transaction_type IN ('withdrawal','transfer_out') THEN -t.amount ELSE 0 END)
 ELSE 0 END),0),
 count(*) FILTER(WHERE t.transaction_type NOT IN ('collection','withdrawal','transfer_in','transfer_out')),
 count(*) FILTER(WHERE t.transaction_type IN ('transfer_in','transfer_out'))
 INTO s_cash,s_wallet,v_cash_unknown,v_cash_transfer_movements
 FROM public.account_transactions t JOIN public.company_accounts a
 ON a.id=t.account_id AND a.tenant_id=t.tenant_id
 WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.occurred_at<v_cutoff;
 v_rows:=jsonb_build_array(
 jsonb_build_object('code','1200','label','ذمم المشتركين','glBalance',g_ar,'subledgerBalance',s_ar,
 'difference',g_ar-s_ar,'status',CASE WHEN v_invoice_invalid>0 OR v_invoice_changed>0 OR v_later_payments>0 OR v_invoice_current<>s_ar
 THEN 'BLOCKED_SOURCE_SNAPSHOT' WHEN g_ar=s_ar THEN 'MATCHED' ELSE 'DIFFERENCE' END,
 'source','INVOICES_MINUS_COMPLETED_PAYMENTS','invoiceBalanceCheckDifference',v_invoice_current-s_ar),
 jsonb_build_object('code','2300','label','ذمم الموردين','glBalance',g_ap,'subledgerBalance',s_ap,
 'difference',g_ap-s_ap,'status',CASE WHEN g_ap=s_ap THEN 'MATCHED' ELSE 'DIFFERENCE' END,
 'source','SUPPLIER_LEDGER_CREDIT_MINUS_DEBIT'),
 jsonb_build_object('code','1300','label','المخزون والوقود','glBalance',g_stock,'subledgerBalance',s_stock,
 'difference',g_stock-s_stock,'status',CASE WHEN v_stock_unknown>0 OR v_stock_uncosted>0 THEN 'BLOCKED_UNMAPPED_MOVEMENT'
 WHEN g_stock=s_stock THEN 'MATCHED' ELSE 'DIFFERENCE' END,
 'source','STOCK_MOVEMENT_COST_ROLLFORWARD'),
 jsonb_build_object('code','1010','label','الصندوق','glBalance',g_cash,'subledgerBalance',s_cash,
 'difference',g_cash-s_cash,'status',CASE WHEN v_cash_transfer_movements>0 THEN 'BLOCKED_UNPOSTED_ACCOUNT_TRANSFER'
 WHEN v_cash_unknown>0 OR v_cash_openings>0 THEN 'BLOCKED_COMPANY_ACCOUNT_SCOPE'
 WHEN g_cash=s_cash THEN 'MATCHED' ELSE 'DIFFERENCE' END,'source','SITE_CASH_TRANSACTIONS_NET'),
 jsonb_build_object('code','1020','label','البنوك والمحافظ','glBalance',g_wallet,'subledgerBalance',s_wallet,
 'difference',g_wallet-s_wallet,'status',CASE WHEN v_cash_transfer_movements>0 THEN 'BLOCKED_UNPOSTED_ACCOUNT_TRANSFER'
 WHEN v_cash_unknown>0 OR v_cash_openings>0 THEN 'BLOCKED_COMPANY_ACCOUNT_SCOPE'
 WHEN g_wallet=s_wallet THEN 'MATCHED' ELSE 'DIFFERENCE' END,'source','SITE_NONCASH_TRANSACTIONS_NET')
 );
 SELECT count(*) FILTER(WHERE x->>'status'<>'MATCHED'),
 count(*) FILTER(WHERE (x->>'difference')::numeric<>0)
 INTO v_bad,v_mismatch FROM jsonb_array_elements(v_rows) x;
 RETURN jsonb_build_object('tenantId',p_tenant_id,'siteId',p_site_id,'period',p_period,
 'periodEndExclusive',v_cutoff,'glEntryCount',v_gl_entries,'sourceScope','SITE_OPERATIONAL_SUBLEDGERS',
 'status',CASE WHEN v_bad=0 THEN 'MATCHED_NUMERICALLY_NOT_CERTIFIED' ELSE 'BLOCKED_RECONCILIATION' END,
 'accountingCertification','NOT_CERTIFIED','isFinalBalanceSheet',false,'isApproved',false,
 'isMathematicallyMatched',v_bad=0,'differenceCount',v_mismatch,'unresolvedCount',v_bad,
 'checks',v_rows,
 'diagnostics',jsonb_build_object('invoiceInvalidCount',v_invoice_invalid,
 'invoicesChangedAfterCutoff',v_invoice_changed,'paymentsAfterCutoff',v_later_payments,
 'invoiceCreditsWithoutHistoricalDate',v_invoice_credits,
 'unknownStockMovements',v_stock_unknown,'uncostedStockMovements',v_stock_uncosted,
 'unknownCompanyTransactionTypes',v_cash_unknown,'unpostedTransferMovements',v_cash_transfer_movements,'unallocatableCompanyOpeningAccounts',v_cash_openings),
 'limitations',jsonb_build_array('AGGREGATE_ONLY_NOT_DOCUMENT_LEVEL',
 'NO_SITE_ATTRIBUTABLE_COMPANY_ACCOUNT_OPENINGS','UNPOSTED_COMPANY_TRANSFER_GL_NOT_SUPPORTED',
 'NO_HISTORICAL_CREDIT_APPLIED_DATES',
 'NOT_A_INDEPENDENT_HUMAN_REVIEW'));
END;
$function$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text) TO service_role;
