\set ON_ERROR_STOP on

DO $roles$
BEGIN
  BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END;
END
$roles$;

CREATE TABLE public.tenant_subscriptions(
  id bigint PRIMARY KEY,status text NOT NULL,started_at timestamptz,
  ends_at timestamptz,trial_duration_days integer,auto_renew boolean,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.financial_settlements(
  id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL,status text NOT NULL,
  period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.sites(
  id bigint PRIMARY KEY,invoice_due_days integer NOT NULL,invoice_due_hours integer NOT NULL,updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.subscribers(
  id bigint PRIMARY KEY,subscriber_no text NOT NULL,updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.platform_announcements(id bigint PRIMARY KEY,title text,updated_at timestamptz DEFAULT now());
CREATE TABLE public.powerhub_message_automations(id bigint PRIMARY KEY,name text,updated_at timestamptz DEFAULT now());
CREATE TABLE public.powerhub_message_templates(id bigint PRIMARY KEY,name text,updated_at timestamptz DEFAULT now());
CREATE TABLE public.updated_at_probe(id bigint PRIMARY KEY,updated_at timestamptz DEFAULT now());

CREATE FUNCTION public.powerhub_apply_trial_duration()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $function$
DECLARE v_days integer;
BEGIN
  IF NEW.status='trial' THEN
    IF NEW.started_at IS NULL THEN NEW.started_at:=coalesce(OLD.started_at,now()); END IF;
    IF TG_OP='UPDATE' AND NEW.ends_at IS DISTINCT FROM OLD.ends_at
       AND NEW.trial_duration_days IS NOT DISTINCT FROM OLD.trial_duration_days THEN
      IF NEW.ends_at<=NEW.started_at THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Trial end must follow start.';
      END IF;
      v_days:=greatest(1,ceil(extract(epoch FROM (NEW.ends_at-NEW.started_at))/86400.0)::integer);
      NEW.trial_duration_days:=v_days;
    ELSE
      NEW.trial_duration_days:=greatest(1,coalesce(NEW.trial_duration_days,8));
      NEW.ends_at:=NEW.started_at+make_interval(days=>NEW.trial_duration_days);
    END IF;
    NEW.auto_renew:=false;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.powerhub_guard_locked_financial_settlement()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status='locked' THEN RAISE EXCEPTION 'LOCKED_SETTLEMENT_IMMUTABLE' USING ERRCODE='P0001'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='locked' THEN
    RAISE EXCEPTION 'LOCKED_SETTLEMENT_IMMUTABLE' USING ERRCODE='P0001';
  END IF;
  IF NEW.status='locked' THEN
    PERFORM pg_advisory_xact_lock(NEW.site_id);
    IF EXISTS (
      SELECT 1 FROM public.financial_settlements s
      WHERE s.tenant_id=NEW.tenant_id AND s.site_id=NEW.site_id AND s.status='locked'
        AND s.id<>coalesce(NEW.id,0) AND s.period_start<NEW.period_end AND NEW.period_start<s.period_end
    ) THEN RAISE EXCEPTION 'SETTLEMENT_PERIOD_OVERLAP' USING ERRCODE='P0001'; END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.powerhub_set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $function$
BEGIN NEW.updated_at:=now(); RETURN NEW; END;
$function$;

CREATE FUNCTION public.powerhub_subscriber_reference_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $function$
BEGIN
  IF NEW.subscriber_no IS DISTINCT FROM OLD.subscriber_no THEN
    RAISE EXCEPTION 'SUBSCRIBER_REFERENCE_IMMUTABLE' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.powerhub_sync_invoice_due_interval()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $function$
BEGIN
  IF NEW.invoice_due_days IS DISTINCT FROM OLD.invoice_due_days
     AND NEW.invoice_due_hours IS NOT DISTINCT FROM OLD.invoice_due_hours THEN
    NEW.invoice_due_hours:=greatest(1,least(2160,NEW.invoice_due_days*24));
  ELSIF NEW.invoice_due_hours IS DISTINCT FROM OLD.invoice_due_hours
     AND NEW.invoice_due_days IS NOT DISTINCT FROM OLD.invoice_due_days THEN
    NEW.invoice_due_days:=greatest(1,least(90,ceil(NEW.invoice_due_hours::numeric/24)::integer));
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.powerhub_touch_platform_announcement()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $function$
BEGIN NEW.updated_at:=now(); RETURN NEW; END;
$function$;

CREATE FUNCTION public.powerhub_touch_unified_messaging_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $function$
BEGIN NEW.updated_at:=now(); RETURN NEW; END;
$function$;

CREATE TRIGGER trg_powerhub_trial_duration
BEFORE INSERT OR UPDATE OF status,started_at,ends_at,trial_duration_days
ON public.tenant_subscriptions FOR EACH ROW EXECUTE FUNCTION public.powerhub_apply_trial_duration();
CREATE TRIGGER trg_powerhub_guard_locked_financial_settlement
BEFORE INSERT OR DELETE OR UPDATE ON public.financial_settlements
FOR EACH ROW EXECUTE FUNCTION public.powerhub_guard_locked_financial_settlement();
CREATE TRIGGER updated_at_probe_trigger BEFORE UPDATE ON public.updated_at_probe
FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at();
CREATE TRIGGER subscribers_reference_immutable BEFORE UPDATE ON public.subscribers
FOR EACH ROW EXECUTE FUNCTION public.powerhub_subscriber_reference_immutable();
CREATE TRIGGER powerhub_sync_invoice_due_interval_trigger
BEFORE UPDATE OF invoice_due_days,invoice_due_hours ON public.sites
FOR EACH ROW EXECUTE FUNCTION public.powerhub_sync_invoice_due_interval();
CREATE TRIGGER platform_announcements_touch_updated_at
BEFORE UPDATE ON public.platform_announcements
FOR EACH ROW EXECUTE FUNCTION public.powerhub_touch_platform_announcement();
CREATE TRIGGER powerhub_message_automations_updated_at
BEFORE UPDATE ON public.powerhub_message_automations
FOR EACH ROW EXECUTE FUNCTION public.powerhub_touch_unified_messaging_updated_at();
CREATE TRIGGER powerhub_message_templates_updated_at
BEFORE UPDATE ON public.powerhub_message_templates
FOR EACH ROW EXECUTE FUNCTION public.powerhub_touch_unified_messaging_updated_at();

-- Reproduce overly broad default grants from PUBLIC and browser roles.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC,anon,authenticated,service_role;
\ir ../migrations/20261106130000_powerhub_project_trigger_functions_server_only_acl.sql

DO $assert_acl$
DECLARE v_sig text; v_fn regprocedure;
BEGIN
 FOREACH v_sig IN ARRAY ARRAY[
  'public.powerhub_apply_trial_duration()',
  'public.powerhub_guard_locked_financial_settlement()',
  'public.powerhub_set_updated_at()',
  'public.powerhub_subscriber_reference_immutable()',
  'public.powerhub_sync_invoice_due_interval()',
  'public.powerhub_touch_platform_announcement()',
  'public.powerhub_touch_unified_messaging_updated_at()'
 ] LOOP
  v_fn:=to_regprocedure(v_sig);
  IF has_function_privilege('anon',v_fn,'EXECUTE')
     OR has_function_privilege('authenticated',v_fn,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_fn,'EXECUTE') THEN
    RAISE EXCEPTION 'PROJECT_TRIGGER_ACL_ASSERTION_FAILED: %',v_sig;
  END IF;
 END LOOP;
END
$assert_acl$;

INSERT INTO public.tenant_subscriptions(id,status,started_at,trial_duration_days,auto_renew)
VALUES(1,'trial','2026-11-01T00:00:00Z',8,true);
DO $trial$
BEGIN
 IF (SELECT ends_at FROM public.tenant_subscriptions WHERE id=1)<>'2026-11-09T00:00:00Z'::timestamptz
    OR (SELECT auto_renew FROM public.tenant_subscriptions WHERE id=1) THEN
  RAISE EXCEPTION 'TRIAL_DURATION_TRIGGER_BROKEN_AFTER_ACL_REVOKE';
 END IF;
END
$trial$;

INSERT INTO public.financial_settlements(id,tenant_id,site_id,status,period_start,period_end)
VALUES(1,10,100,'locked','2026-10-01T00:00:00Z','2026-11-01T00:00:00Z');
DO $locked$
BEGIN
 BEGIN UPDATE public.financial_settlements SET status='open' WHERE id=1;
  RAISE EXCEPTION 'LOCKED_SETTLEMENT_MUTATION_WAS_ALLOWED';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'LOCKED_SETTLEMENT_IMMUTABLE' THEN RAISE; END IF;
 END;
 BEGIN INSERT INTO public.financial_settlements(id,tenant_id,site_id,status,period_start,period_end)
  VALUES(2,10,100,'locked','2026-10-15T00:00:00Z','2026-11-15T00:00:00Z');
  RAISE EXCEPTION 'OVERLAPPING_LOCKED_SETTLEMENT_WAS_ALLOWED';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'SETTLEMENT_PERIOD_OVERLAP' THEN RAISE; END IF;
 END;
END
$locked$;

INSERT INTO public.sites(id,invoice_due_days,invoice_due_hours) VALUES(1,2,48);
UPDATE public.sites SET invoice_due_days=3 WHERE id=1;
DO $due$
BEGIN
 IF (SELECT invoice_due_hours FROM public.sites WHERE id=1)<>72 THEN
  RAISE EXCEPTION 'INVOICE_DUE_INTERVAL_SYNC_TRIGGER_BROKEN';
 END IF;
END
$due$;

INSERT INTO public.subscribers(id,subscriber_no) VALUES(1,'PWR-0001');
DO $subscriber$
BEGIN
 BEGIN UPDATE public.subscribers SET subscriber_no='PWR-0002' WHERE id=1;
  RAISE EXCEPTION 'SUBSCRIBER_REFERENCE_MUTATION_WAS_ALLOWED';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'SUBSCRIBER_REFERENCE_IMMUTABLE' THEN RAISE; END IF;
 END;
END
$subscriber$;

INSERT INTO public.updated_at_probe(id) VALUES(1);
UPDATE public.updated_at_probe SET updated_at='2000-01-01T00:00:00Z' WHERE id=1;
INSERT INTO public.platform_announcements(id,title) VALUES(1,'Fixture');
UPDATE public.platform_announcements SET updated_at='2000-01-01T00:00:00Z' WHERE id=1;
INSERT INTO public.powerhub_message_automations(id,name) VALUES(1,'Fixture');
UPDATE public.powerhub_message_automations SET updated_at='2000-01-01T00:00:00Z' WHERE id=1;
INSERT INTO public.powerhub_message_templates(id,name) VALUES(1,'Fixture');
UPDATE public.powerhub_message_templates SET updated_at='2000-01-01T00:00:00Z' WHERE id=1;

DO $timestamps$
BEGIN
 IF (SELECT updated_at FROM public.updated_at_probe WHERE id=1)<='2000-01-01T00:00:00Z'::timestamptz
  OR (SELECT updated_at FROM public.platform_announcements WHERE id=1)<='2000-01-01T00:00:00Z'::timestamptz
  OR (SELECT updated_at FROM public.powerhub_message_automations WHERE id=1)<='2000-01-01T00:00:00Z'::timestamptz
  OR (SELECT updated_at FROM public.powerhub_message_templates WHERE id=1)<='2000-01-01T00:00:00Z'::timestamptz THEN
  RAISE EXCEPTION 'UPDATED_AT_TRIGGER_BROKEN_AFTER_ACL_REVOKE';
 END IF;
END
$timestamps$;

SELECT 'project trigger function ACL regression passed' AS result;
