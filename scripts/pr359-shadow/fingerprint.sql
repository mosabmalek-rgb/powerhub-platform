-- Compare exactly the same aggregate postconditions across three fresh networkless Docker restores.
WITH s AS (
 SELECT count(*)::bigint invoices, coalesce(sum(total_amount),0)::numeric(14,2) invoiced,
 coalesce(sum(paid_amount),0)::numeric(14,2) paid,coalesce(sum(balance_due),0)::numeric(14,2) due,
 count(*) FILTER(WHERE status<>'cancelled' AND abs(total_amount-paid_amount-balance_due)>0.01) mismatch FROM public.invoices
),p AS(
 SELECT count(*)::bigint payments,coalesce(sum(amount),0)::numeric(14,2) cash_received,
 count(*) FILTER(WHERE invoice_id IS NULL AND status='completed') unlinked FROM public.payments
),cash AS(
 SELECT count(*)::bigint transactions,coalesce(sum(amount),0)::numeric(18,2) gross_transactions,
 count(*) FILTER(WHERE related_payment_id IS NOT NULL) payment_cash_links FROM public.account_transactions
), ledger AS(
 SELECT count(*)::bigint balance_entries,
 coalesce(sum(amount) FILTER(WHERE direction='credit'),0)::numeric(14,2) credit,
 coalesce(sum(amount) FILTER(WHERE direction='debit'),0)::numeric(14,2) debit FROM public.subscriber_balance_ledger
),migrations AS(
 SELECT count(*)::bigint total_migrations,
 count(*) FILTER(WHERE version IN('20261103131052','20261103131104','20261103131125','20261103145232')) finance_migrations
 FROM supabase_migrations.schema_migrations
),invariants AS(
 SELECT count(*) FILTER(WHERE payment_purpose IN('invoice_collection','invoice_collection_with_credit')
 AND abs(amount-invoice_applied_amount-subscriber_credit_amount)>0.01) invalid_payment_split FROM public.payments
),acl AS(
 SELECT count(*)::bigint public_definer_functions,
 count(*) FILTER(WHERE has_function_privilege('anon',p.oid,'EXECUTE')) anonymous_executable_definers
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prosecdef
)
SELECT jsonb_build_object('invoice',(SELECT to_jsonb(x) FROM s x),
'payment',(SELECT to_jsonb(x) FROM p x),
'account_transactions',(SELECT to_jsonb(x) FROM cash x),
'subscriber_balance_ledger',(SELECT to_jsonb(x) FROM ledger x),
'migrations',(SELECT to_jsonb(x) FROM migrations x),
'payment_invariants',(SELECT to_jsonb(x) FROM invariants x),
'acl',(SELECT to_jsonb(x) FROM acl x))::text;
