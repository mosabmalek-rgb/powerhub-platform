-- PR359 Phase-1: read-only PostgreSQL catalog evidence for three Production records without retained SQL.
-- No customer/business rows are queried; do not call any SECURITY DEFINER RPC here.
WITH funcs AS (
 SELECT p.oid::regprocedure::text signature, p.proname, pg_get_userbyid(p.proowner) owner,
 p.prosecdef security_definer, p.proconfig config,
 has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') service_execute,
 encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex') definition_sha256,
 position('trial_ends_at' in pg_get_functiondef(p.oid))>0 uses_trial_ends_at,
 position('subscription-trial-ending' in pg_get_functiondef(p.oid))>0 uses_trial_dedupe,
 position('p_subscription_duration' in pg_get_functiondef(p.oid))>0 uses_duration,
 position('invoice_applied_amount' in pg_get_functiondef(p.oid))>0 uses_invoice_applied_amount,
 position('and p.payment_purpose in' in pg_get_functiondef(p.oid))>0 filters_invoice_collection_purpose
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN (
 'powerhub_process_subscription_lifecycle',
 'powerhub_dashboard_operational_summary',
 'powerhub_dashboard_financial_overview',
 'powerhub_admin_complete_generator_owner_provisioning')
), cols AS (
 SELECT column_name,data_type,is_nullable,column_default
 FROM information_schema.columns
 WHERE table_schema='public' AND table_name='tenant_subscriptions'
 AND column_name IN ('trial_enabled','trial_ends_at','ends_at','trial_duration_days')
), idx AS (
 SELECT indexname,indexdef FROM pg_indexes
 WHERE schemaname='public' AND indexname IN (
 'tenant_subscriptions_trial_ends_at_idx','invoices_dashboard_open_debt_idx',
 'expenses_tenant_site_occurred_at_id_idx')
), lifecycle_jobs AS (
 SELECT jobname,schedule,active,username,database FROM cron.job
 WHERE jobname='powerhub-subscription-lifecycle'
)
SELECT jsonb_build_object(
 'functions',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY signature),'[]'::jsonb) FROM funcs f),
 'columns',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY column_name),'[]'::jsonb) FROM cols c),
 'indexes',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY indexname),'[]'::jsonb) FROM idx i),
 'lifecycleJobs',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY jobname),'[]'::jsonb) FROM lifecycle_jobs j)
) AS audit;
