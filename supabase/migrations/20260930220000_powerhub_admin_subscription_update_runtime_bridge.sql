-- Compatibility bridge for the current admin subscription UI.
-- The production database exposes the idempotent subscription-update RPC,
-- while the current admin runtime calls the legacy-shaped function signature.
-- Keep the public API stable and delegate to the authoritative idempotent RPC.

drop function if exists public.powerhub_admin_update_subscription(
  bigint, bigint, text, text, text, timestamptz, boolean, text, bigint
);

create function public.powerhub_admin_update_subscription(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_package_code text,
  p_status text,
  p_billing_cycle text,
  p_ends_at timestamptz,
  p_auto_renew boolean,
  p_notes text default null,
  p_sms_plan_id bigint default null
)
returns table(success boolean, subscription_id bigint, site_id bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_operation_id text;
  v_result record;
begin
  v_operation_id := 'admin-subscription-update:' ||
    md5(concat_ws(
      '|',
      p_actor_user_id::text,
      p_tenant_id::text,
      lower(nullif(btrim(p_package_code), '')),
      p_status,
      p_billing_cycle,
      p_ends_at::text,
      p_auto_renew::text,
      coalesce(p_notes, ''),
      coalesce(p_sms_plan_id::text, '')
    ));

  select *
    into v_result
  from public.powerhub_admin_update_subscription_idempotent(
    p_actor_user_id => p_actor_user_id,
    p_tenant_id => p_tenant_id,
    p_package_code => p_package_code,
    p_status => p_status,
    p_billing_cycle => p_billing_cycle,
    p_ends_at => p_ends_at,
    p_auto_renew => p_auto_renew,
    p_notes => p_notes,
    p_sms_plan_id => p_sms_plan_id,
    p_client_operation_id => v_operation_id
  );

  return query
    select
      v_result.success,
      v_result.subscription_id,
      v_result.site_id;
end;
$$;

revoke all on function public.powerhub_admin_update_subscription(
  bigint, bigint, text, text, text, timestamptz, boolean, text, bigint
) from public, anon, authenticated;

grant execute on function public.powerhub_admin_update_subscription(
  bigint, bigint, text, text, text, timestamptz, boolean, text, bigint
) to service_role;
