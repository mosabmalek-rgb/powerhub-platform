-- PR359 P0 live-catalog evidence. Read-only, no RPC invocation, no business rows.
-- Run unchanged against Staging and Production; attach project ref and source SHA externally.
WITH funcs AS (
 SELECT n.nspname schema_name,p.proname function_name,
   pg_get_function_identity_arguments(p.oid) identity_args,
   p.prosecdef security_definer,pg_get_userbyid(p.proowner) owner_role,
   p.proconfig function_settings,
   has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
   has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
   has_function_privilege('service_role',p.oid,'EXECUTE') service_execute,
   encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') definition_sha256
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE (n.nspname='public' AND p.proname IN (
   'powerhub_admin_subscription_upgrade_requests','powerhub_has_platform_capability',
   'powerhub_enforce_field_user_quota','powerhub_admin_set_platform_access_role',
   'powerhub_create_reading','powerhub_unified_messaging_history',
   'powerhub_dashboard_financial_overview'))
 OR (n.nspname='private' AND p.proname IN (
   'powerhub_has_platform_capability','chat_after_support_conversation_create',
   'chat_notify_message_visibility','chat_prepare_support_conversation'))
), policies AS (
 SELECT schemaname,tablename,policyname,cmd,roles,
   encode(sha256(convert_to(coalesce(qual,'')||'/'||coalesce(with_check,''),'UTF8')),'hex') predicate_sha256,
   left(coalesce(qual,''),550) predicate_prefix,
   left(coalesce(with_check,''),250) with_check_prefix
 FROM pg_policies
 WHERE (schemaname='public' AND tablename IN (
     'chat_messages','chat_conversations','chat_conversation_tags',
     'chat_support_assignments','chat_ticket_events','chat_support_feedback'))
 OR (schemaname='realtime' AND tablename='messages' AND policyname LIKE 'chat_%')
 OR (schemaname='storage' AND tablename='objects' AND policyname LIKE 'chat_%')
), tables AS (
 SELECT n.nspname schema_name,c.relname table_name,c.relrowsecurity rls_enabled,
   has_table_privilege('anon',c.oid,'SELECT') anon_select,
   has_table_privilege('authenticated',c.oid,'INSERT') authenticated_insert,
   has_table_privilege('authenticated',c.oid,'UPDATE') authenticated_update,
   has_table_privilege('authenticated',c.oid,'DELETE') authenticated_delete
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE (n.nspname='storage' AND c.relname='objects')
 OR (n.nspname='public' AND c.relname='chat_messages')
), finance_columns AS (
 SELECT column_name,data_type FROM information_schema.columns
 WHERE table_schema='public' AND table_name='payments'
 AND column_name IN ('payment_purpose','invoice_applied_amount','subscriber_credit_amount')
), core_migrations AS (
 SELECT version,name,
   (statements IS NOT NULL AND cardinality(statements)>0) sql_available
 FROM supabase_migrations.schema_migrations
 WHERE version IN (
 '20261103131052','20261103131104','20261103131125','20261103145232',
 '20261107130443','20261108111500','20261108120000')
)
SELECT jsonb_build_object(
 'functions',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY schema_name,function_name,identity_args),'[]'::jsonb) FROM funcs f),
 'policies',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname),'[]'::jsonb) FROM policies p),
 'tables',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY schema_name,table_name),'[]'::jsonb) FROM tables t),
 'financeColumns',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY column_name),'[]'::jsonb) FROM finance_columns c),
 'creditLedger',to_regclass('public.subscriber_balance_ledger')::text,
 'coreMigrations',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY version),'[]'::jsonb) FROM core_migrations m),
 'privateAnonUsage',(SELECT has_schema_privilege('anon',oid,'USAGE') FROM pg_namespace WHERE nspname='private')
) AS audit;
