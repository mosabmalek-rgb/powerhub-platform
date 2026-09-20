-- Hardening: subscriber portal read RPCs are invoked by the PowerHub server with service_role.
-- Keep direct PostgREST execution closed to public/anon/authenticated roles.
revoke all on function public.powerhub_subscriber_portal_list() from public;
revoke all on function public.powerhub_subscriber_portal_list() from anon;
revoke all on function public.powerhub_subscriber_portal_list() from authenticated;
grant execute on function public.powerhub_subscriber_portal_list() to service_role;

revoke all on function public.powerhub_subscriber_portal_theme(text) from public;
revoke all on function public.powerhub_subscriber_portal_theme(text) from anon;
revoke all on function public.powerhub_subscriber_portal_theme(text) from authenticated;
grant execute on function public.powerhub_subscriber_portal_theme(text) to service_role;
