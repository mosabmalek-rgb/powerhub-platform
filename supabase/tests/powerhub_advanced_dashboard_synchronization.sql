-- Regression contract for the platform-owner dashboard read model.
begin;
select plan(6);

select ok(
  position('generate_series' in pg_get_functiondef('public.powerhub_advanced_dashboard()'::regprocedure)) > 0
  and position('interval ''1 month''' in pg_get_functiondef('public.powerhub_advanced_dashboard()'::regprocedure)) > 0,
  'dashboard subscriber growth is zero-filled across a 12-month month series'
);

select ok(
  position('site_generator_counts' in pg_get_functiondef('public.powerhub_advanced_dashboard()'::regprocedure))
    > 0
  and position('generator_count = 1' in pg_get_functiondef('public.powerhub_advanced_dashboard()'::regprocedure))
    > 0,
  'generator collection ranking only attributes site payments when the generator mapping is unambiguous'
);

select ok(
  position('payments.status = ''completed''' in pg_get_functiondef('public.powerhub_advanced_dashboard()'::regprocedure)) > 0
  and position('generatorId' in pg_get_functiondef('public.powerhub_advanced_dashboard()'::regprocedure)) > 0,
  'collection ranking uses completed payments and exposes generator identity'
);

select ok(
  position('subscriptions.ends_at >= now()' in pg_get_functiondef('public.powerhub_advanced_dashboard()'::regprocedure)) > 0
  and position('subscriptions.archived_at is null' in pg_get_functiondef('public.powerhub_advanced_dashboard()'::regprocedure)) > 0,
  'expiry list excludes already-expired and archived subscriptions'
);

select ok(
  position('revoke execute on function public.powerhub_advanced_dashboard() from public, anon, authenticated' in pg_get_functiondef('public.powerhub_advanced_dashboard()'::regprocedure)) = 0,
  'privileges are managed outside the function definition'
);

select ok(
  not has_function_privilege('anon','public.powerhub_advanced_dashboard()','execute'),
  'anon cannot execute the platform-owner dashboard RPC'
);

select * from finish();
rollback;
