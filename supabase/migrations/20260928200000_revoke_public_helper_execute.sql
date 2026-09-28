-- Security boundary: browser roles must not execute trigger/internal helper functions directly.
-- These functions are invoked by reviewed server-side paths or database triggers only.
revoke all on function public.powerhub_next_invoice_sms_run(timestamptz, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.powerhub_sync_sms_lease() from public, anon, authenticated;
revoke all on function public.powerhub_touch_platform_announcement() from public, anon, authenticated;

grant execute on function public.powerhub_next_invoice_sms_run(timestamptz, text, text, timestamptz) to service_role;
grant execute on function public.powerhub_sync_sms_lease() to service_role;
grant execute on function public.powerhub_touch_platform_announcement() to service_role;
