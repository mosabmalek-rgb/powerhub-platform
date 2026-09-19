-- Subscription upgrade workflow: package_code is authoritative; plan remains compatibility-only.
do $$
declare v_sql text;
begin
  select pg_get_functiondef(p.oid) into v_sql from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='powerhub_request_subscription_upgrade' and p.prokind='f'
  order by p.oid desc limit 1;
  if v_sql is null or v_sql not like '%v_requested_package%' then
    raise exception 'PACKAGE_CONTRACT_REGRESSION: upgrade request RPC is not package-aware';
  end if;

  select pg_get_functiondef(p.oid) into v_sql from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='powerhub_admin_review_subscription_upgrade_request' and p.prokind='f'
  order by p.oid desc limit 1;
  if v_sql is null or v_sql not like '%package_code%' or v_sql not like '%requestedPackage%' then
    raise exception 'PACKAGE_CONTRACT_REGRESSION: upgrade review RPC is not package-aware';
  end if;
end $$;
