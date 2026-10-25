-- Quota alerts contain tenant usage counts and are consumed only by trusted server RPCs.
-- RLS plus explicit revocation prevents direct browser-role reads of this server-only table.
ALTER TABLE public.powerhub_quota_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.powerhub_quota_alerts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.powerhub_quota_alerts TO service_role;
