-- Restore Production-equivalent triggers missing from Staging.
-- Definitions are sourced from the live Production catalog. Existing trigger
-- definitions are left intact; missing triggers are created only after preflight.

CREATE OR REPLACE FUNCTION public.powerhub_guard_locked_financial_settlement()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
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

CREATE OR REPLACE FUNCTION public.powerhub_guard_tenant_feature_control_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.feature_catalog
    WHERE feature_key=NEW.feature_key AND feature_type IN ('quota','addon','hybrid')
  ) THEN RAISE EXCEPTION 'FEATURE_NOT_TENANT_CONTROLLABLE' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_apply_trial_duration()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE v_days integer;
BEGIN
  IF NEW.status='trial' THEN
    IF NEW.started_at IS NULL THEN NEW.started_at:=coalesce(OLD.started_at,now()); END IF;
    IF TG_OP='UPDATE' AND NEW.ends_at IS DISTINCT FROM OLD.ends_at
       AND NEW.trial_duration_days IS NOT DISTINCT FROM OLD.trial_duration_days THEN
      IF NEW.ends_at<=NEW.started_at THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='تاريخ انتهاء التجربة يجب أن يكون بعد تاريخ البدء.';
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

CREATE OR REPLACE FUNCTION public.powerhub_sync_sms_addon_end_to_subscription()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE v_subscription_end timestamptz;
BEGIN
  IF NEW.addon_code<>'sms' OR NEW.status<>'approved' THEN RETURN NEW; END IF;
  SELECT ts.ends_at INTO v_subscription_end
  FROM public.tenant_subscriptions ts
  WHERE ts.tenant_id=NEW.tenant_id
  ORDER BY ts.ends_at DESC NULLS LAST,ts.id DESC LIMIT 1;
  IF v_subscription_end IS NOT NULL THEN
    NEW.ends_at:=v_subscription_end;
    NEW.duration_days:=greatest(1,ceil(extract(epoch FROM (v_subscription_end-coalesce(NEW.starts_at,now())))/86400.0)::integer);
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.powerhub_guard_tenant_feature_control_scope() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_guard_tenant_feature_control_scope() TO service_role;
REVOKE ALL ON FUNCTION public.powerhub_sync_sms_addon_end_to_subscription() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_sync_sms_addon_end_to_subscription() TO service_role;


DO $preflight$
DECLARE v record;
BEGIN
  IF to_regprocedure('public.powerhub_set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_SET_UPDATED_AT_FUNCTION_MISSING';
  END IF;
  FOR v IN
    SELECT * FROM (VALUES
      ('collector_sessions','collector_sessions_set_updated_at','BEFORE UPDATE ON public.collector_sessions FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('custom_permission_roles','custom_permission_roles_set_updated_at','BEFORE UPDATE ON public.custom_permission_roles FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('employees','employees_set_updated_at','BEFORE UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('financial_settlements','financial_settlements_set_updated_at','BEFORE UPDATE ON public.financial_settlements FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('platform_sms_fallback_providers','platform_sms_fallback_providers_set_updated_at','BEFORE UPDATE ON public.platform_sms_fallback_providers FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('platform_sms_plans','platform_sms_plans_set_updated_at','BEFORE UPDATE ON public.platform_sms_plans FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('platform_tweetsms_accounts','platform_tweetsms_accounts_set_updated_at','BEFORE UPDATE ON public.platform_tweetsms_accounts FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('platform_tweetsms_balance_alerts','platform_tweetsms_balance_alerts_set_updated_at','BEFORE UPDATE ON public.platform_tweetsms_balance_alerts FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('staff_profiles','staff_profiles_set_updated_at','BEFORE UPDATE ON public.staff_profiles FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('subscribers','subscribers_set_updated_at','BEFORE UPDATE ON public.subscribers FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('tenant_branch_settings','tenant_branch_settings_set_updated_at','BEFORE UPDATE ON public.tenant_branch_settings FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('tenant_owner_profiles','tenant_owner_profiles_set_updated_at','BEFORE UPDATE ON public.tenant_owner_profiles FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('tenant_subscriptions','tenant_subscriptions_set_updated_at','BEFORE UPDATE ON public.tenant_subscriptions FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('tenant_tweetsms_accounts','tenant_tweetsms_accounts_set_updated_at','BEFORE UPDATE ON public.tenant_tweetsms_accounts FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('tenants','tenants_set_updated_at','BEFORE UPDATE ON public.tenants FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('users','users_set_updated_at','BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('financial_settlements','trg_powerhub_guard_locked_financial_settlement','BEFORE INSERT OR DELETE OR UPDATE ON public.financial_settlements FOR EACH ROW EXECUTE FUNCTION public.powerhub_guard_locked_financial_settlement()'),
      ('tenant_addon_requests','trg_powerhub_sync_sms_addon_end','BEFORE INSERT OR UPDATE OF status, starts_at, ends_at, duration_days ON public.tenant_addon_requests FOR EACH ROW EXECUTE FUNCTION public.powerhub_sync_sms_addon_end_to_subscription()'),
      ('tenant_feature_controls','trg_powerhub_tenant_feature_control_scope','BEFORE INSERT OR UPDATE ON public.tenant_feature_controls FOR EACH ROW EXECUTE FUNCTION public.powerhub_guard_tenant_feature_control_scope()'),
      ('tenant_subscriptions','trg_powerhub_trial_duration','BEFORE INSERT OR UPDATE OF status, started_at, ends_at, trial_duration_days ON public.tenant_subscriptions FOR EACH ROW EXECUTE FUNCTION public.powerhub_apply_trial_duration()')
    ) AS x(table_name,trigger_name,trigger_definition)
  LOOP
    IF to_regclass(format('public.%I',v.table_name)) IS NULL THEN
      RAISE EXCEPTION 'POWERHUB_TRIGGER_TABLE_MISSING: %',v.table_name;
    END IF;
  END LOOP;
END
$preflight$;

DO $restore_triggers$
DECLARE
  v record;
  v_definition text;
BEGIN
  FOR v IN
    SELECT * FROM (VALUES
      ('collector_sessions','collector_sessions_set_updated_at','BEFORE UPDATE ON public.collector_sessions FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('custom_permission_roles','custom_permission_roles_set_updated_at','BEFORE UPDATE ON public.custom_permission_roles FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('employees','employees_set_updated_at','BEFORE UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('financial_settlements','financial_settlements_set_updated_at','BEFORE UPDATE ON public.financial_settlements FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('platform_sms_fallback_providers','platform_sms_fallback_providers_set_updated_at','BEFORE UPDATE ON public.platform_sms_fallback_providers FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('platform_sms_plans','platform_sms_plans_set_updated_at','BEFORE UPDATE ON public.platform_sms_plans FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('platform_tweetsms_accounts','platform_tweetsms_accounts_set_updated_at','BEFORE UPDATE ON public.platform_tweetsms_accounts FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('platform_tweetsms_balance_alerts','platform_tweetsms_balance_alerts_set_updated_at','BEFORE UPDATE ON public.platform_tweetsms_balance_alerts FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('staff_profiles','staff_profiles_set_updated_at','BEFORE UPDATE ON public.staff_profiles FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('subscribers','subscribers_set_updated_at','BEFORE UPDATE ON public.subscribers FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('tenant_branch_settings','tenant_branch_settings_set_updated_at','BEFORE UPDATE ON public.tenant_branch_settings FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('tenant_owner_profiles','tenant_owner_profiles_set_updated_at','BEFORE UPDATE ON public.tenant_owner_profiles FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('tenant_subscriptions','tenant_subscriptions_set_updated_at','BEFORE UPDATE ON public.tenant_subscriptions FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('tenant_tweetsms_accounts','tenant_tweetsms_accounts_set_updated_at','BEFORE UPDATE ON public.tenant_tweetsms_accounts FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('tenants','tenants_set_updated_at','BEFORE UPDATE ON public.tenants FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('users','users_set_updated_at','BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.powerhub_set_updated_at()'),
      ('financial_settlements','trg_powerhub_guard_locked_financial_settlement','BEFORE INSERT OR DELETE OR UPDATE ON public.financial_settlements FOR EACH ROW EXECUTE FUNCTION public.powerhub_guard_locked_financial_settlement()'),
      ('tenant_addon_requests','trg_powerhub_sync_sms_addon_end','BEFORE INSERT OR UPDATE OF status, starts_at, ends_at, duration_days ON public.tenant_addon_requests FOR EACH ROW EXECUTE FUNCTION public.powerhub_sync_sms_addon_end_to_subscription()'),
      ('tenant_feature_controls','trg_powerhub_tenant_feature_control_scope','BEFORE INSERT OR UPDATE ON public.tenant_feature_controls FOR EACH ROW EXECUTE FUNCTION public.powerhub_guard_tenant_feature_control_scope()'),
      ('tenant_subscriptions','trg_powerhub_trial_duration','BEFORE INSERT OR UPDATE OF status, started_at, ends_at, trial_duration_days ON public.tenant_subscriptions FOR EACH ROW EXECUTE FUNCTION public.powerhub_apply_trial_duration()')
    ) AS x(table_name,trigger_name,trigger_definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid=to_regclass(format('public.%I',v.table_name))
        AND tgname=v.trigger_name AND NOT tgisinternal
    ) THEN
      v_definition:=format('CREATE TRIGGER %I %s',v.trigger_name,v.trigger_definition);
      EXECUTE v_definition;
    END IF;
  END LOOP;
END
$restore_triggers$;
