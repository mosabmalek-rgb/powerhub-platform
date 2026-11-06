
-- Remove direct RPC-style EXECUTE from browser roles on project-owned trigger functions.
-- PostgreSQL invokes a trigger function through its trigger binding; it does not
-- require the invoking DML role to hold direct EXECUTE on the trigger function.
DO $trigger_acl_preflight$
DECLARE
  v_signature text;
  v_function regprocedure;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.powerhub_apply_trial_duration()',
    'public.powerhub_guard_locked_financial_settlement()',
    'public.powerhub_set_updated_at()',
    'public.powerhub_subscriber_reference_immutable()',
    'public.powerhub_sync_invoice_due_interval()',
    'public.powerhub_touch_platform_announcement()',
    'public.powerhub_touch_unified_messaging_updated_at()'
  ] LOOP
    v_function := to_regprocedure(v_signature);
    IF v_function IS NULL THEN
      RAISE EXCEPTION 'PROJECT_TRIGGER_FUNCTION_MISSING: %',v_signature;
    END IF;
    IF (SELECT prorettype FROM pg_proc WHERE oid=v_function)<>'trigger'::regtype
       OR (SELECT prosecdef FROM pg_proc WHERE oid=v_function) THEN
      RAISE EXCEPTION 'PROJECT_TRIGGER_FUNCTION_SECURITY_MODE_CHANGED: %',v_signature;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgfoid=v_function AND tgenabled<>'D' AND NOT tgisinternal
    ) THEN
      RAISE EXCEPTION 'PROJECT_TRIGGER_FUNCTION_NOT_ATTACHED: %',v_signature;
    END IF;
  END LOOP;
END
$trigger_acl_preflight$;

REVOKE ALL PRIVILEGES ON FUNCTION public.powerhub_apply_trial_duration()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.powerhub_guard_locked_financial_settlement()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.powerhub_set_updated_at()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.powerhub_subscriber_reference_immutable()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.powerhub_sync_invoice_due_interval()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.powerhub_touch_platform_announcement()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.powerhub_touch_unified_messaging_updated_at()
  FROM PUBLIC, anon, authenticated;

DO $trigger_acl_postflight$
DECLARE
  v_signature text;
  v_function regprocedure;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.powerhub_apply_trial_duration()',
    'public.powerhub_guard_locked_financial_settlement()',
    'public.powerhub_set_updated_at()',
    'public.powerhub_subscriber_reference_immutable()',
    'public.powerhub_sync_invoice_due_interval()',
    'public.powerhub_touch_platform_announcement()',
    'public.powerhub_touch_unified_messaging_updated_at()'
  ] LOOP
    v_function := to_regprocedure(v_signature);
    IF has_function_privilege('anon',v_function,'EXECUTE')
       OR has_function_privilege('authenticated',v_function,'EXECUTE') THEN
      RAISE EXCEPTION 'PROJECT_TRIGGER_BROWSER_EXECUTE_REMAINS: %',v_signature;
    END IF;
    IF NOT has_function_privilege('service_role',v_function,'EXECUTE') THEN
      RAISE EXCEPTION 'PROJECT_TRIGGER_SERVICE_ROLE_ACCESS_CHANGED: %',v_signature;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgfoid=v_function AND tgenabled<>'D' AND NOT tgisinternal
    ) THEN
      RAISE EXCEPTION 'PROJECT_TRIGGER_ATTACHMENT_LOST: %',v_signature;
    END IF;
  END LOOP;
END
$trigger_acl_postflight$;
