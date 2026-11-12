-- B5.20 consolidated database-fresh authorization snapshot; service_role only.
CREATE OR REPLACE FUNCTION public.powerhub_site_access_snapshot(p_user_id bigint,p_site_id bigint)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $sql$
 SELECT jsonb_build_object(
 'user',(SELECT jsonb_build_object('role',u.role,'platform_role',u.platform_role,'account_status',u.account_status) FROM public.users u WHERE u.id=p_user_id),
 'site',(SELECT jsonb_build_object('tenant_id',s.tenant_id,'status',s.status,'invoice_due_days',s.invoice_due_days,'invoice_due_hours',s.invoice_due_hours) FROM public.sites s WHERE s.id=p_site_id),
 'membership',(SELECT jsonb_build_object('role',m.role,'expires_at',m.expires_at,'is_active',m.is_active,'membership_status',m.membership_status) FROM public.tenant_members m JOIN public.sites s ON s.tenant_id=m.tenant_id WHERE s.id=p_site_id AND m.user_id=p_user_id AND m.is_active=true AND m.membership_status='active' AND (m.expires_at IS NULL OR m.expires_at>now()) ORDER BY m.id DESC LIMIT 1),
 'subscription',(SELECT jsonb_build_object('status',sub.status,'ends_at',sub.ends_at,'read_only_until',sub.read_only_until) FROM public.tenant_subscriptions sub JOIN public.sites s ON s.tenant_id=sub.tenant_id WHERE s.id=p_site_id ORDER BY sub.ends_at DESC NULLS LAST LIMIT 1),
 'member_overrides',(SELECT coalesce(jsonb_agg(jsonb_build_object('capability',o.capability,'is_allowed',o.is_allowed)),'[]'::jsonb) FROM public.tenant_member_capability_overrides o JOIN public.sites s ON s.tenant_id=o.tenant_id WHERE s.id=p_site_id AND o.user_id=p_user_id),
 'staff_profiles',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',sp.id,'site_id',sp.site_id,'role',sp.role,'permissions',sp.permissions,'custom_role_id',sp.custom_role_id,'suspension_started_at',sp.suspension_started_at,'suspension_ends_at',sp.suspension_ends_at) ORDER BY sp.id),'[]'::jsonb) FROM public.staff_profiles sp JOIN public.sites s ON s.tenant_id=sp.tenant_id WHERE s.id=p_site_id AND sp.user_id=p_user_id AND sp.is_active AND sp.archived_at IS NULL AND (sp.site_id=p_site_id OR sp.site_id IS NULL)),
 'staff_overrides',(SELECT coalesce(jsonb_agg(jsonb_build_object('profile_id',o.profile_id,'capability',o.capability,'is_allowed',o.is_allowed)),'[]'::jsonb) FROM public.staff_profile_capability_overrides o JOIN public.sites s ON s.tenant_id=o.tenant_id JOIN public.staff_profiles sp ON sp.id=o.profile_id AND sp.tenant_id=o.tenant_id WHERE s.id=p_site_id AND sp.user_id=p_user_id AND sp.is_active AND sp.archived_at IS NULL AND (sp.site_id=p_site_id OR sp.site_id IS NULL)),
 'custom_roles',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',cr.id,'permissions',cr.permissions)),'[]'::jsonb) FROM public.custom_permission_roles cr JOIN public.sites s ON s.tenant_id=cr.tenant_id JOIN public.staff_profiles sp ON sp.custom_role_id=cr.id AND sp.tenant_id=cr.tenant_id WHERE s.id=p_site_id AND sp.user_id=p_user_id AND sp.is_active AND sp.archived_at IS NULL AND (sp.site_id=p_site_id OR sp.site_id IS NULL) AND cr.is_active),
 'role_policies',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',rp.role,'capability',rp.capability,'is_allowed',rp.is_allowed)),'[]'::jsonb) FROM public.platform_role_policies rp WHERE rp.role IN ('owner','manager','accountant','collector','technician','viewer'))
 );
$sql$;
REVOKE ALL ON FUNCTION public.powerhub_site_access_snapshot(bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_site_access_snapshot(bigint,bigint) TO service_role;
