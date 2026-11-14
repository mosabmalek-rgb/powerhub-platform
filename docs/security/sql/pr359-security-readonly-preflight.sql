-- Read-only catalog collection only. Does not establish deployed API schema exposure.
-- Run only through an authorized read-only connection. Never execute test fixtures here.
BEGIN READ ONLY;
SET LOCAL statement_timeout='15s';
SELECT current_database() AS database_name,current_user,version() AS postgres_version;
SELECT version,name,
 CASE WHEN statements IS NULL OR cardinality(statements)=0
   OR nullif(array_to_string(statements,E'\n'),'') IS NULL THEN NULL
 ELSE encode(sha256(convert_to(array_to_string(statements,E'\n'),'UTF8')),'hex') END AS retained_sql_sha256
FROM supabase_migrations.schema_migrations
WHERE version IN ('20261107120000','20261107130000','20261107130443','20261107140000',
 '20261107143819','20261107150000','20261107150951')
 OR name IN ('powerhub_inventory_supplier_site_rls_scope','powerhub_inventory_phase_d_supplier_allocation_scope',
 'powerhub_platform_support_identity_role_guard','powerhub_inventory_supplier_payables_allocation_scope',
 'powerhub_company_account_capability_search_path','powerhub_supplier_browser_read_acl_revoke',
 'powerhub_public_default_privilege_hardening')
ORDER BY version,name;
SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
 has_table_privilege('anon',c.oid,'SELECT') AS anon_table_select,
 has_any_column_privilege('anon',c.oid,'SELECT') AS anon_column_select,
 has_table_privilege('authenticated',c.oid,'SELECT') AS authenticated_table_select,
 has_any_column_privilege('authenticated',c.oid,'SELECT') AS authenticated_column_select,
 has_table_privilege('service_role',c.oid,'SELECT') AS service_select
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('suppliers','supplier_purchases','supplier_purchase_lines',
 'supplier_purchase_receipts','supplier_purchase_receipt_lines','supplier_payments',
 'supplier_payment_allocations','supplier_ledger_entries','supplier_purchase_returns','supplier_purchase_return_lines')
ORDER BY c.relname;
SELECT n.nspname,p.oid::regprocedure AS signature,pg_get_userbyid(p.proowner) AS owner,
 p.prosecdef,p.proconfig,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute,
 encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') AS definition_sha256
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('public','private') AND p.proname IN (
 'powerhub_has_platform_capability','powerhub_has_company_account_capability',
 'powerhub_inventory_phase_d_financial_details','powerhub_inventory_supplier_payables_aging',
 'chat_after_support_conversation_create','chat_notify_message_visibility','chat_prepare_support_conversation')
ORDER BY n.nspname,p.oid::regprocedure::text;
SELECT t.tgname,n.nspname AS table_schema,c.relname AS table_name,t.tgenabled,
 p.oid::regprocedure AS trigger_function
FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE NOT t.tgisinternal AND p.proname IN
 ('chat_after_support_conversation_create','chat_notify_message_visibility','chat_prepare_support_conversation')
ORDER BY n.nspname,c.relname,t.tgname;
SELECT pg_get_userbyid(d.defaclrole) AS owner,coalesce(n.nspname,'<global>') AS schema_name,
 d.defaclobjtype,d.defaclacl
FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
WHERE d.defaclrole IN ('postgres'::regrole,'supabase_admin'::regrole)
ORDER BY owner,schema_name,d.defaclobjtype;
SELECT n.nspname,p.oid::regprocedure AS unreviewed_postgres_routine
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE p.proowner='postgres'::regrole AND n.nspname NOT IN
 ('public','private','powerhub_private','extensions','storage','pg_catalog','information_schema');
SELECT current_setting('pgrst.db_schemas',true) AS exposed_schema_setting_if_available;
-- NULL above is UNKNOWN; get API exposure from project settings separately.
SELECT e.extname,e.extversion,n.nspname AS extension_schema,pg_get_userbyid(e.extowner) AS owner
FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname IN ('pg_net','pg_cron');
-- Never select Vault values or cron.job.command (commands may contain secrets).
ROLLBACK;
