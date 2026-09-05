create or replace function public.powerhub_record_platform_tweetsms_test(
  p_user_id bigint,
  p_success boolean,
  p_balance integer,
  p_error text
)
returns table (account_id bigint, is_active boolean, last_provider_balance integer, last_tested_at timestamptz, last_error text)
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  v_account public.platform_tweetsms_accounts%rowtype;
begin
  perform 1 from public.users
    where public.users.id = p_user_id
      and public.users.account_status = 'active'
      and public.users.platform_role in ('platform_owner', 'platform_admin');
  if not found then raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode = 'P0001'; end if;

  select pta.* into v_account
    from public.platform_tweetsms_accounts as pta
    order by pta.updated_at desc, pta.id desc
    limit 1
    for update;
  if not found then raise exception 'TWEETSMS_ACCOUNT_NOT_FOUND' using errcode = 'P0001'; end if;

  update public.platform_tweetsms_accounts as pta
    set last_tested_at = now(),
        last_provider_balance = case when p_balance is null then pta.last_provider_balance else p_balance end,
        last_balance_checked_at = case when p_balance is null then pta.last_balance_checked_at else now() end,
        last_error = case when p_success then null else coalesce(nullif(left(trim(p_error), 2000), ''), 'فشل فحص TweetSMS.') end,
        is_active = case when p_success then v_account.is_active else false end,
        updated_by_user_id = p_user_id,
        updated_at = now()
    where pta.id = v_account.id
    returning pta.id, pta.is_active, pta.last_provider_balance, pta.last_tested_at, pta.last_error
    into account_id, is_active, last_provider_balance, last_tested_at, last_error;

  if p_success and p_balance is not null then
    if p_balance <= v_account.low_balance_threshold then
      if not exists (
        select 1
        from public.platform_tweetsms_balance_alerts as pba
        where pba.account_id = v_account.id
          and pba.status = 'open'
      ) then
        insert into public.platform_tweetsms_balance_alerts(account_id, balance, threshold, status)
          values (v_account.id, p_balance, v_account.low_balance_threshold, 'open');
      end if;
    else
      update public.platform_tweetsms_balance_alerts as pba
        set status = 'resolved', resolved_at = now(), updated_at = now()
        where pba.account_id = v_account.id
          and pba.status = 'open';
    end if;
  end if;

  insert into public.platform_security_events(event_type, severity, status, title, details, metadata, created_by_user_id)
    values (
      'security_change',
      case when p_success then 'info' else 'warning' end,
      case when p_success then 'success' else 'failed' end,
      'فحص اتصال TweetSMS المركزي',
      case when p_success then 'نجح فحص حساب مزود الرسائل.' else 'فشل فحص حساب مزود الرسائل.' end,
      jsonb_build_object('accountId', account_id, 'success', p_success, 'balanceAvailable', p_balance is not null),
      p_user_id
    );

  return next;
end;
$$;

revoke execute on function public.powerhub_record_platform_tweetsms_test(bigint, boolean, integer, text) from public, anon, authenticated;
grant execute on function public.powerhub_record_platform_tweetsms_test(bigint, boolean, integer, text) to service_role;
