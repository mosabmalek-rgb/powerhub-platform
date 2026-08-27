create or replace function public.powerhub_save_platform_tweetsms_account(
  p_user_id bigint,
  p_api_endpoint text,
  p_credential_ciphertext text,
  p_credential_iv text,
  p_sender_name text,
  p_low_balance_threshold integer,
  p_is_active boolean
)
returns table (account_id bigint, api_endpoint text, sender_name text, low_balance_threshold integer, is_active boolean, activation_required boolean)
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  v_account public.platform_tweetsms_accounts%rowtype;
  v_exists boolean := false;
  v_changed boolean := false;
  v_effective_active boolean;
begin
  perform 1 from public.users
    where id = p_user_id and account_status = 'active' and platform_role in ('platform_owner', 'platform_admin');
  if not found then raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode = 'P0001'; end if;
  if nullif(trim(p_api_endpoint), '') is null or nullif(trim(p_credential_ciphertext), '') is null or nullif(trim(p_credential_iv), '') is null then
    raise exception 'TWEETSMS_CREDENTIALS_REQUIRED' using errcode = 'P0001';
  end if;
  if p_low_balance_threshold < 0 then raise exception 'INVALID_LOW_BALANCE_THRESHOLD' using errcode = 'P0001'; end if;

  select * into v_account from public.platform_tweetsms_accounts order by updated_at desc, id desc limit 1 for update;
  v_exists := found;
  if v_exists then
    v_changed := v_account.api_endpoint is distinct from trim(p_api_endpoint)
      or v_account.credential_ciphertext is distinct from p_credential_ciphertext
      or v_account.credential_iv is distinct from p_credential_iv
      or v_account.sender_name is distinct from nullif(trim(p_sender_name), '');
    v_effective_active := case when v_changed then false else p_is_active end;
    update public.platform_tweetsms_accounts
      set api_endpoint = trim(p_api_endpoint), credential_ciphertext = p_credential_ciphertext, credential_iv = p_credential_iv,
          sender_name = nullif(trim(p_sender_name), ''), low_balance_threshold = p_low_balance_threshold,
          is_active = v_effective_active, last_tested_at = case when v_changed then null else v_account.last_tested_at end,
          last_error = case when v_changed then 'بانتظار فحص اتصال TweetSMS بعد تغيير الإعداد.' else v_account.last_error end,
          updated_by_user_id = p_user_id, updated_at = now()
      where id = v_account.id
      returning id, api_endpoint, sender_name, low_balance_threshold, is_active
      into account_id, api_endpoint, sender_name, low_balance_threshold, is_active;
  else
    v_effective_active := false;
    insert into public.platform_tweetsms_accounts(
      api_endpoint, credential_ciphertext, credential_iv, sender_name, low_balance_threshold, is_active, last_error, created_by_user_id, updated_by_user_id
    ) values (
      trim(p_api_endpoint), p_credential_ciphertext, p_credential_iv, nullif(trim(p_sender_name), ''), p_low_balance_threshold, false,
      'بانتظار فحص اتصال TweetSMS قبل التفعيل.', p_user_id, p_user_id
    ) returning id, api_endpoint, sender_name, low_balance_threshold, is_active
      into account_id, api_endpoint, sender_name, low_balance_threshold, is_active;
    v_changed := true;
  end if;

  insert into public.platform_security_events(event_type, severity, status, title, details, metadata, created_by_user_id)
    values (
      'security_change', 'info', 'success', 'تحديث إعداد TweetSMS المركزي', 'حُفظت إعدادات مزود الرسائل بصورة مشفرة.',
      jsonb_build_object('accountId', account_id, 'apiEndpoint', api_endpoint, 'senderName', sender_name, 'requestedActive', p_is_active, 'effectiveActive', is_active, 'credentialsChanged', v_changed),
      p_user_id
    );
  activation_required := v_changed;
  return next;
end;
$$;

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
    where id = p_user_id and account_status = 'active' and platform_role in ('platform_owner', 'platform_admin');
  if not found then raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode = 'P0001'; end if;
  select * into v_account from public.platform_tweetsms_accounts order by updated_at desc, id desc limit 1 for update;
  if not found then raise exception 'TWEETSMS_ACCOUNT_NOT_FOUND' using errcode = 'P0001'; end if;

  update public.platform_tweetsms_accounts
    set last_tested_at = now(),
        last_provider_balance = case when p_balance is null then last_provider_balance else p_balance end,
        last_balance_checked_at = case when p_balance is null then last_balance_checked_at else now() end,
        last_error = case when p_success then null else coalesce(nullif(left(trim(p_error), 2000), ''), 'فشل فحص TweetSMS.') end,
        is_active = case when p_success then is_active else false end,
        updated_by_user_id = p_user_id,
        updated_at = now()
    where id = v_account.id
    returning id, is_active, last_provider_balance, last_tested_at, last_error
    into account_id, is_active, last_provider_balance, last_tested_at, last_error;

  if p_success and p_balance is not null then
    if p_balance <= v_account.low_balance_threshold then
      if not exists (select 1 from public.platform_tweetsms_balance_alerts where account_id = v_account.id and status = 'open') then
        insert into public.platform_tweetsms_balance_alerts(account_id, balance, threshold, status)
          values (v_account.id, p_balance, v_account.low_balance_threshold, 'open');
      end if;
    else
      update public.platform_tweetsms_balance_alerts set status = 'resolved', resolved_at = now(), updated_at = now()
        where account_id = v_account.id and status = 'open';
    end if;
  end if;

  insert into public.platform_security_events(event_type, severity, status, title, details, metadata, created_by_user_id)
    values (
      'security_change', case when p_success then 'info' else 'warning' end, case when p_success then 'success' else 'failed' end,
      'فحص اتصال TweetSMS المركزي', case when p_success then 'نجح فحص حساب مزود الرسائل.' else 'فشل فحص حساب مزود الرسائل.' end,
      jsonb_build_object('accountId', account_id, 'success', p_success, 'balanceAvailable', p_balance is not null), p_user_id
    );
  return next;
end;
$$;

revoke execute on function public.powerhub_save_platform_tweetsms_account(bigint, text, text, text, text, integer, boolean) from public, anon, authenticated;
revoke execute on function public.powerhub_record_platform_tweetsms_test(bigint, boolean, integer, text) from public, anon, authenticated;
grant execute on function public.powerhub_save_platform_tweetsms_account(bigint, text, text, text, text, integer, boolean) to service_role;
grant execute on function public.powerhub_record_platform_tweetsms_test(bigint, boolean, integer, text) to service_role;
