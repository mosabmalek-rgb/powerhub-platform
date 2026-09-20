-- Hardening: scheduled platform announcement publishing is an internal cron/server operation only.
revoke all on function public.powerhub_publish_due_platform_announcements() from public;
revoke all on function public.powerhub_publish_due_platform_announcements() from anon;
revoke all on function public.powerhub_publish_due_platform_announcements() from authenticated;
grant execute on function public.powerhub_publish_due_platform_announcements() to service_role;
