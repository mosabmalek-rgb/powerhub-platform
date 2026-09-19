create or replace function public.powerhub_get_sms_quota(p_tenant_id bigint,p_period_start timestamptz default date_trunc('month',now()))
returns table(subscription_id bigint,sms_plan_id bigint,plan_code text,plan_name text,base_messages bigint,additional_messages bigint,total_messages bigint,used_segments bigint,remaining_messages bigint)
language sql security definer set search_path to 'public','pg_temp' as $$
with current_subscription as (
 select ts.id,ts.sms_plan_id,coalesce(nullif(lower(btrim(ts.package_code)),''),case ts.plan when 'starter' then 'basic' when 'professional' then 'advanced' when 'enterprise' then 'business' end) package_code
 from public.tenant_subscriptions ts where ts.tenant_id=p_tenant_id order by ts.created_at desc,ts.id desc limit 1
), package as (
 select cs.id subscription_id,cs.sms_plan_id,cs.package_code,coalesce(pkg->>'name',cs.package_code) plan_name,
 coalesce((pkg->'features'->'sms'->>'limit')::bigint,(pkg->>'includedMessages')::bigint,0) base_messages
 from current_subscription cs left join public.platform_settings s on s.setting_key='subscription_package_catalog' and s.is_enabled=true
 left join lateral jsonb_array_elements(coalesce(s.value->'packages','[]'::jsonb)) pkg on pkg->>'code'=cs.package_code and coalesce((pkg->>'active')::boolean,true)=true
), extras as (
 select coalesce(sum(r.approved_messages),0)::bigint additional_messages from public.sms_package_requests r cross join package
 where r.tenant_id=p_tenant_id and r.status='approved' and r.reviewed_at>=p_period_start and r.reviewed_at<p_period_start+interval '1 month'
 and (r.subscription_id=package.subscription_id or(r.subscription_id is null and package.subscription_id is not null))
), usage as (
 select coalesce(sum(greatest(coalesce(m.segment_count,1),1)),0)::bigint used_segments from public.notification_messages m
 where m.tenant_id=p_tenant_id and m.channel='sms' and m.created_at>=p_period_start and m.status in('processing','submitted','delivered','read','needs_review')
)
select package.subscription_id,package.sms_plan_id,package.package_code,package.plan_name,package.base_messages,extras.additional_messages,package.base_messages+extras.additional_messages,usage.used_segments,greatest(package.base_messages+extras.additional_messages-usage.used_segments,0)
from package cross join extras cross join usage;
$$;