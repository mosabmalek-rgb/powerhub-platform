-- Preserve the current runtime state of the two legacy feature entitlements.
insert into public.tenant_feature_controls(
  tenant_id,feature_key,status,limit_mode,manual_limit,override_reason,updated_by_user_id,updated_at
)
select
  e.tenant_id,
  e.feature_key,
  case when e.is_enabled then 'enabled' else 'disabled' end,
  'inherit',
  null,
  'ترحيل أولي من tenant_feature_entitlements',
  e.activated_by_user_id,
  coalesce(e.updated_at,now())
from public.tenant_feature_entitlements e
where e.feature_key in ('subscriber_portal_logo','payment_documentation')
on conflict (tenant_id,feature_key) do nothing;
