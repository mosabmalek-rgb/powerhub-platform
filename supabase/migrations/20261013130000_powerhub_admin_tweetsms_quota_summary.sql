-- Authoritative SMS quota summary for platform-admin TweetSMS setup cards.
-- The displayed limit and usage are derived from the same policy and statuses
-- enforced by powerhub_claim_sms_notification; account.monthly_limit is only a mirror.
create or replace function public.powerhub_admin_tweetsms_quota_summary(
  p_user_id bigint,
  p_tenant_ids bigint[]
)
returns table (
  tenant_id bigint,
  monthly_limit integer,
  monthly_limit_mode text,
  sms_feature_eligible boolean,
  sms_feature_enabled boolean,
  used_this_month bigint,
  remaining bigint
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
begin
  if not exists (
    select 1
    from public.users u
    where u.id = p_user_id
      and u.account_status = 'active'
      and u.platform_role in ('platform_owner', 'platform_admin')
  ) then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode = 'P0001';
  end if;

  if p_tenant_ids is null then
    raise exception 'TENANT_SELECTION_REQUIRED' using errcode = '22023';
  end if;

  return query
  with requested_tenants as (
    select distinct t.id
    from unnest(p_tenant_ids) as selected(id)
    join public.tenants t on t.id = selected.id
  ),
  policies as (
    select
      requested.id as tenant_id,
      policy.eligible,
      policy.enabled,
      policy.effective_limit,
      policy.effective_limit_mode
    from requested_tenants requested
    left join lateral public.powerhub_resolve_tenant_feature_policy(requested.id, 'sms') as policy on true
  ),
  usage as (
    select
      messages.tenant_id,
      sum(greatest(coalesce(messages.segment_count, 1), 1))::bigint as used_segments
    from public.notification_messages messages
    join requested_tenants requested on requested.id = messages.tenant_id
    where messages.channel = 'sms'
      and messages.created_at >= date_trunc('month', now())
      and messages.status in ('processing', 'submitted', 'delivered', 'read', 'needs_review')
    group by messages.tenant_id
  )
  select
    policies.tenant_id,
    case
      when policies.effective_limit_mode = 'unlimited' then 0
      else greatest(coalesce(policies.effective_limit, 0), 0)
    end::integer as monthly_limit,
    coalesce(policies.effective_limit_mode, 'inherit')::text as monthly_limit_mode,
    coalesce(policies.eligible, false) as sms_feature_eligible,
    coalesce(policies.enabled, false) as sms_feature_enabled,
    coalesce(usage.used_segments, 0)::bigint as used_this_month,
    case
      when policies.effective_limit_mode = 'unlimited' then null::bigint
      else greatest(coalesce(policies.effective_limit, 0)::bigint - coalesce(usage.used_segments, 0), 0)::bigint
    end as remaining
  from policies
  left join usage on usage.tenant_id = policies.tenant_id
  order by policies.tenant_id;
end;
$function$;

revoke execute on function public.powerhub_admin_tweetsms_quota_summary(bigint, bigint[]) from public, anon, authenticated;
grant execute on function public.powerhub_admin_tweetsms_quota_summary(bigint, bigint[]) to service_role;
