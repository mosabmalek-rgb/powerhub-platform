-- PR359 CB-A only. Execute as read-only catalog SELECT on the specifically
-- approved source connection; never use for DDL, grants or data mutation.
-- The result is incomplete as a runtime call graph: pg_trigger captures
-- direct noninternal trigger bindings, not application RPC/dynamic calls.
SELECT p.oid::regprocedure::text AS function_identity,
       p.prosecdef AS security_definer,
       array_to_string(p.proconfig, ',') AS configured_search_path,
       has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
       has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute,
       t.tgname AS trigger_name,
       t.tgenabled AS trigger_enabled,
       c.oid::regclass::text AS trigger_relation,
       pg_get_triggerdef(t.oid,true) AS trigger_definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN pg_trigger t ON t.tgfoid = p.oid AND NOT t.tgisinternal
LEFT JOIN pg_class c ON c.oid = t.tgrelid
WHERE n.nspname='public'
  AND p.proname IN (
    'powerhub_ensure_owner_main_site',
    'powerhub_mobile_touch_session',
    'powerhub_refresh_fuel_maintenance_delta_after_generator_name_up'
  )
ORDER BY p.proname, t.tgname;
