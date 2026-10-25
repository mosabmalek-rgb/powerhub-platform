\set ON_ERROR_STOP on

DO $roles$
BEGIN
  BEGIN CREATE ROLE anon nologin; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE authenticated nologin; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE service_role nologin; EXCEPTION WHEN duplicate_object THEN NULL; END;
END
$roles$;

CREATE TABLE public.notification_trigger_probe (
  id bigint generated always as identity primary key,
  source text not null
);
CREATE TABLE public.notification_trigger_probe_events (
  id bigint generated always as identity primary key,
  trigger_name text not null
);

CREATE OR REPLACE FUNCTION public.powerhub_notify_admin_pending_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  INSERT INTO public.notification_trigger_probe_events(trigger_name) VALUES (TG_NAME);
  RETURN NEW;
END
$fn$;
CREATE OR REPLACE FUNCTION public.powerhub_notify_field_sync_received()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  INSERT INTO public.notification_trigger_probe_events(trigger_name) VALUES (TG_NAME);
  RETURN NEW;
END
$fn$;
CREATE OR REPLACE FUNCTION public.powerhub_notify_payment_documentation_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  INSERT INTO public.notification_trigger_probe_events(trigger_name) VALUES (TG_NAME);
  RETURN NEW;
END
$fn$;

GRANT EXECUTE ON FUNCTION public.powerhub_notify_admin_pending_request() TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_notify_field_sync_received() TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_notify_payment_documentation_request() TO PUBLIC, anon, authenticated, service_role;
GRANT INSERT ON public.notification_trigger_probe TO authenticated;

CREATE TRIGGER probe_admin_notify AFTER INSERT ON public.notification_trigger_probe
FOR EACH ROW EXECUTE FUNCTION public.powerhub_notify_admin_pending_request();
CREATE TRIGGER probe_field_notify AFTER INSERT ON public.notification_trigger_probe
FOR EACH ROW EXECUTE FUNCTION public.powerhub_notify_field_sync_received();
CREATE TRIGGER probe_payment_notify AFTER INSERT ON public.notification_trigger_probe
FOR EACH ROW EXECUTE FUNCTION public.powerhub_notify_payment_documentation_request();

\ir ../migrations/20261024211000_powerhub_notification_trigger_rpc_hardening.sql

DO $assert_acl$
BEGIN
  IF has_function_privilege('anon','public.powerhub_notify_admin_pending_request()'::regprocedure,'EXECUTE')
     OR has_function_privilege('authenticated','public.powerhub_notify_admin_pending_request()'::regprocedure,'EXECUTE')
     OR has_function_privilege('anon','public.powerhub_notify_field_sync_received()'::regprocedure,'EXECUTE')
     OR has_function_privilege('authenticated','public.powerhub_notify_field_sync_received()'::regprocedure,'EXECUTE')
     OR has_function_privilege('anon','public.powerhub_notify_payment_documentation_request()'::regprocedure,'EXECUTE')
     OR has_function_privilege('authenticated','public.powerhub_notify_payment_documentation_request()'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'NOTIFICATION_TRIGGER_RPC_STILL_EXPOSED_TO_BROWSER_ROLES';
  END IF;

  IF NOT has_function_privilege('service_role','public.powerhub_notify_admin_pending_request()'::regprocedure,'EXECUTE')
     OR NOT has_function_privilege('service_role','public.powerhub_notify_field_sync_received()'::regprocedure,'EXECUTE')
     OR NOT has_function_privilege('service_role','public.powerhub_notify_payment_documentation_request()'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'NOTIFICATION_TRIGGER_SERVICE_ROLE_GRANT_REMOVED';
  END IF;
END
$assert_acl$;

SET ROLE authenticated;
INSERT INTO public.notification_trigger_probe(source) VALUES ('post-revoke-trigger-check');
RESET ROLE;

DO $assert_triggers$
BEGIN
  IF (SELECT count(*) FROM public.notification_trigger_probe_events) <> 3 THEN
    RAISE EXCEPTION 'NOTIFICATION_TRIGGER_EXECUTION_BROKEN_AFTER_EXECUTE_REVOKE';
  END IF;
END
$assert_triggers$;

SELECT 'notification trigger RPC hardening: browser execute denied; three database triggers remain functional' AS result;
