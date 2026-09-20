-- PowerHub subscriber portal identity policy
-- Applied to Production during implementation; this file records the intended schema contract.
-- Generator name and logo are exposed only while subscriber_portal_logo entitlement is allowed.

create or replace function public.powerhub_subscriber_portal_list()
returns table(portal_code text, display_name text, primary_color text, accent_color text, site_name text, city text, logo_key text)
language sql stable security definer set search_path=''
as $$
 select s.portal_code,
   case when access.allowed then coalesce(s.display_name, site.name) else 'صفحة استعلامات المشتركين' end,
   s.primary_color,s.accent_color,
   case when access.allowed then site.name else 'صفحة استعلامات المشتركين' end,
   case when access.allowed then site.city else null end,
   case when access.allowed then s.logo_key else null end
 from public.site_portal_settings s
 join public.sites site on site.id=s.site_id
 cross join lateral public.powerhub_subscriber_portal_logo_access(s.tenant_id) access
 where s.is_enabled=true and site.status='active'
 order by site.name asc;
$$;

create or replace function public.powerhub_subscriber_portal_theme(p_portal_code text)
returns table(portal_code text, display_name text, primary_color text, accent_color text, site_name text, city text, logo_key text)
language sql stable security definer set search_path=''
as $$
 select s.portal_code,
   case when access.allowed then coalesce(s.display_name, site.name) else 'صفحة استعلامات المشتركين' end,
   s.primary_color,s.accent_color,
   case when access.allowed then site.name else 'صفحة استعلامات المشتركين' end,
   case when access.allowed then site.city else null end,
   case when access.allowed then s.logo_key else null end
 from public.site_portal_settings s
 join public.sites site on site.id=s.site_id
 cross join lateral public.powerhub_subscriber_portal_logo_access(s.tenant_id) access
 where s.portal_code=lower(btrim(p_portal_code)) and s.is_enabled=true and site.status='active'
 limit 1;
$$;

revoke all on function public.powerhub_subscriber_portal_lookup(text,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_subscriber_portal_lookup(text,text,text) to service_role;
revoke all on function public.powerhub_subscriber_portal_invoice(text,text,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_subscriber_portal_invoice(text,text,text,text) to service_role;
