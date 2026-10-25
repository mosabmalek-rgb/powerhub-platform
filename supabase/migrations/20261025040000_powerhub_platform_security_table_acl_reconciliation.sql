-- Restore platform-admin-only row scope on security settings/events created after
-- the original RLS baseline, and close broad legacy client grants on both tables.
-- All application reads/writes use the server-side service role.
ALTER TABLE public.platform_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_security_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_security_events_platform_admin_only
  ON public.platform_security_events;
CREATE POLICY platform_security_events_platform_admin_only
  ON public.platform_security_events
  AS PERMISSIVE FOR ALL TO authenticated
  USING (private.powerhub_is_platform_admin())
  WITH CHECK (private.powerhub_is_platform_admin());

DROP POLICY IF EXISTS platform_security_events_platform_admin_guard
  ON public.platform_security_events;
CREATE POLICY platform_security_events_platform_admin_guard
  ON public.platform_security_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (private.powerhub_is_platform_admin())
  WITH CHECK (private.powerhub_is_platform_admin());

DROP POLICY IF EXISTS platform_security_settings_platform_admin_only
  ON public.platform_security_settings;
CREATE POLICY platform_security_settings_platform_admin_only
  ON public.platform_security_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (private.powerhub_is_platform_admin())
  WITH CHECK (private.powerhub_is_platform_admin());

DROP POLICY IF EXISTS platform_security_settings_platform_admin_guard
  ON public.platform_security_settings;
CREATE POLICY platform_security_settings_platform_admin_guard
  ON public.platform_security_settings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (private.powerhub_is_platform_admin())
  WITH CHECK (private.powerhub_is_platform_admin());

REVOKE ALL PRIVILEGES ON TABLE public.platform_security_events,
  public.platform_security_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.platform_security_events,
  public.platform_security_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_security_events,
  public.platform_security_settings TO service_role;
