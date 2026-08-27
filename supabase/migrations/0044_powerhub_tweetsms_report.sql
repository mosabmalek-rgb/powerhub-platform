create or replace function public.powerhub_tweetsms_report(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  account jsonb,
  total bigint,
  usage_rows jsonb,
  alerts jsonb
)
language sql
stable
security invoker
set search_path = public
as $$
  with account_row as (
    select id, is_active, sender_name, low_balance_threshold, last_provider_balance,
      last_balance_checked_at, last_error, credential_ciphertext, credential_iv
    from public.platform_tweetsms_accounts
    order by updated_at desc
    limit 1
  ), usage_by_tenant as (
    select messages.tenant_id, tenants.name as tenant_name,
      count(*)::bigint as total,
      count(*) filter (where messages.status = 'submitted')::bigint as submitted,
      count(*) filter (where messages.status = 'failed')::bigint as failed
    from public.notification_messages as messages
    inner join public.tenants on tenants.id = messages.tenant_id
    where messages.channel = 'sms'
      and (p_from is null or messages.created_at >= p_from)
      and (p_to is null or messages.created_at <= p_to)
    group by messages.tenant_id, tenants.name
    order by count(*) desc
    limit 250
  )
  select
    coalesce((
      select jsonb_build_object(
        'id', account_row.id,
        'isActive', account_row.is_active,
        'senderName', account_row.sender_name,
        'lowBalanceThreshold', account_row.low_balance_threshold,
        'lastProviderBalance', account_row.last_provider_balance,
        'lastBalanceCheckedAt', account_row.last_balance_checked_at,
        'lastError', account_row.last_error,
        'configured', account_row.credential_ciphertext is not null and account_row.credential_iv is not null
      )
      from account_row
    ), 'null'::jsonb),
    coalesce((select sum(usage_by_tenant.total) from usage_by_tenant), 0)::bigint,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'tenantId', usage_by_tenant.tenant_id,
        'tenantName', usage_by_tenant.tenant_name,
        'total', usage_by_tenant.total,
        'submitted', usage_by_tenant.submitted,
        'failed', usage_by_tenant.failed
      ) order by usage_by_tenant.total desc)
      from usage_by_tenant
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', alerts.id,
        'balance', alerts.balance,
        'threshold', alerts.threshold,
        'status', alerts.status,
        'notifiedAt', alerts.notified_at,
        'resolvedAt', alerts.resolved_at,
        'createdAt', alerts.created_at,
        'updatedAt', alerts.updated_at
      ) order by alerts.created_at desc)
      from public.platform_tweetsms_balance_alerts as alerts
      inner join account_row on account_row.id = alerts.account_id
      limit 30
    ), '[]'::jsonb);
$$;

revoke execute on function public.powerhub_tweetsms_report(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.powerhub_tweetsms_report(timestamptz, timestamptz) to service_role;
