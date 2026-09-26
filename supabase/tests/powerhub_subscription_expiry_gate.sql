-- Production regression: expired subscriptions must never retain capability access because auto_renew is true.
-- Run in a test transaction/isolated fixture with service_role.
begin;
select plan(4);

-- Function definition must contain an unconditional ends_at expiry gate.
select ok(
  position('if s.ends_at is not null and s.ends_at <= now() then return false; end if;' in pg_get_functiondef('public.powerhub_subscription_allows(bigint,text)'::regprocedure)) > 0,
  'subscription access gate rejects expired ends_at regardless of auto_renew'
);

select ok(
  position('s.status in (''suspended'',''expired'',''cancelled'',''archived'')' in pg_get_functiondef('public.powerhub_subscription_allows(bigint,text)'::regprocedure)) > 0,
  'terminal subscription states are blocked'
);

select has_function_privilege('public','powerhub_subscription_allows(bigint,text)','execute') as service_role_check;
select ok(
  not has_function_privilege('anon','public.powerhub_subscription_allows(bigint,text)','execute'),
  'anon cannot execute subscription access gate'
);

select * from finish();
rollback;
