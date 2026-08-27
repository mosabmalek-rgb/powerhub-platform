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
  if nullif(trim(p_api_endpoint), '') is null then raise exception 'TWEETSMS_ENDPOINT_REQUIRED' using errcode = 'P0001'; end if;
  if p_low_balance_threshold < 0 then raise exception 'INVALID_LOW_BALANCE_THRESHOLD' using errcode = 'P0001'; end if;

  select * into v_account from public.platform_tweetsms_accounts order by updated_at desc, id desc limit 1 for update;
  v_exists := found;
  if v_exists then
    v_changed := v_account.api_endpoint is distinct from trim(p_api_endpoint)
      or v_account.sender_name is distinct from nullif(trim(p_sender_name), '');
    v_effective_active := case when v_changed then false else p_is_active end;
    update public.platform_tweetsms_accounts as a
      set api_endpoint = trim(p_api_endpoint), credential_ciphertext = null, credential_iv = null,
          sender_name = nullif(trim(p_sender_name), ''), low_balance_threshold = p_low_balance_threshold,
          is_active = v_effective_active, last_tested_at = case when v_changed then null else v_account.last_tested_at end,
          last_error = case when v_changed then 'بانتظار فحص اتصال TweetSMS بعد تغيير الإعداد.' else v_account.last_error end,
          updated_by_user_id = p_user_id, updated_at = now()
      where a.id = v_account.id
      returning a.id, a.api_endpoint, a.sender_name, a.low_balance_threshold, a.is_active
      into account_id, api_endpoint, sender_name, low_balance_threshold, is_active;
  else
    v_effective_active := false;
    insert into public.platform_tweetsms_accounts as a(
      api_endpoint, credential_ciphertext, credential_iv, sender_name, low_balance_threshold, is_active, last_error, created_by_user_id, updated_by_user_id
    ) values (
      trim(p_api_endpoint), null, null, nullif(trim(p_sender_name), ''), p_low_balance_threshold, false,
      'بانتظار فحص اتصال TweetSMS قبل التفعيل.', p_user_id, p_user_id
    ) returning a.id, a.api_endpoint, a.sender_name, a.low_balance_threshold, a.is_active
      into account_id, api_endpoint, sender_name, low_balance_threshold, is_active;
    v_changed := true;
  end if;

  insert into public.platform_security_events(event_type, severity, status, title, details, metadata, created_by_user_id)
    values (
      'security_change', 'info', 'success', 'تحديث إعداد TweetSMS المركزي', 'حُفظت إعدادات مزود الرسائل من دون بيانات اعتماد في قاعدة البيانات.',
      jsonb_build_object('accountId', account_id, 'apiEndpoint', api_endpoint, 'senderName', sender_name, 'requestedActive', p_is_active, 'effectiveActive', is_active, 'activationRequired', v_changed),
      p_user_id
    );
  activation_required := v_changed;
  return next;
end;
$$;
