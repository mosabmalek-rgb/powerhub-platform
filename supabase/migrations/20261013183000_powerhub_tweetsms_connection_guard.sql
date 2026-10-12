-- Restore the per-tenant TweetSMS save/test RPCs in staging and require
-- a successful saved connection test before enabling delivery.
create or replace function public.powerhub_save_tenant_tweetsms_account(
  p_user_id bigint,
  p_tenant_id bigint,
  p_api_endpoint text,
  p_credential_ciphertext text,
  p_credential_iv text,
  p_sender_name text,
  p_monthly_limit integer,
  p_is_active boolean
)
returns table (account_id bigint, tenant_id bigint, is_active boolean, activation_required boolean)
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  v_account public.tenant_tweetsms_accounts%rowtype;
  v_site_id bigint;
  v_ciphertext text;
  v_iv text;
  v_exists boolean := false;
  v_changed boolean := false;
  v_effective_active boolean;
  v_feature_policy record;
  v_effective_monthly_limit integer;
begin
  perform 1 from public.users
    where id = p_user_id and account_status = 'active' and platform_role in ('platform_owner', 'platform_admin');
  if not found then raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode = 'P0001'; end if;
  perform 1 from public.tenants where id = p_tenant_id;
  if not found then raise exception 'TENANT_NOT_FOUND' using errcode = 'P0001'; end if;
  select id into v_site_id from public.sites where tenant_id = p_tenant_id and is_active = true order by id limit 1;
  if v_site_id is null then raise exception 'TENANT_SITE_REQUIRED' using errcode = 'P0001'; end if;
  if nullif(trim(p_api_endpoint), '') is null then
    raise exception 'TWEETSMS_ENDPOINT_REQUIRED' using errcode = 'P0001';
  end if;
  if p_monthly_limit < 0 then
    raise exception 'INVALID_MONTHLY_LIMIT' using errcode = 'P0001';
  end if;

  select * into v_feature_policy
  from public.powerhub_resolve_tenant_feature_policy(p_tenant_id, 'sms');

  if not coalesce(v_feature_policy.eligible, false) then
    raise exception 'SMS_FEATURE_NOT_AVAILABLE_IN_PACKAGE' using errcode = 'P0001';
  end if;

  if v_feature_policy.effective_limit_mode = 'unlimited' then
    v_effective_monthly_limit := 2147483647;
  elsif v_feature_policy.effective_limit is not null then
    v_effective_monthly_limit := v_feature_policy.effective_limit;
  else
    raise exception 'SMS_LIMIT_UNCONFIGURED' using errcode = 'P0001';
  end if;

  select * into v_account from public.tenant_tweetsms_accounts where tenant_tweetsms_accounts.tenant_id = p_tenant_id for update;
  v_exists := found;
  if v_exists then
    v_ciphertext := coalesce(nullif(trim(p_credential_ciphertext), ''), v_account.credential_ciphertext);
    v_iv := coalesce(nullif(trim(p_credential_iv), ''), v_account.credential_iv);
    if nullif(trim(v_ciphertext), '') is null or nullif(trim(v_iv), '') is null then raise exception 'TWEETSMS_CREDENTIALS_REQUIRED' using errcode = 'P0001'; end if;
    v_changed := v_account.api_endpoint is distinct from trim(p_api_endpoint)
      or v_account.credential_ciphertext is distinct from v_ciphertext
      or v_account.credential_iv is distinct from v_iv
      or v_account.sender_name is distinct from nullif(trim(p_sender_name), '');
    v_effective_active := case
      when v_changed then false
      when p_is_active and (v_account.last_tested_at is null or v_account.last_error is not null) then false
      else p_is_active
    end;
    update public.tenant_tweetsms_accounts as a
      set api_endpoint = trim(p_api_endpoint), credential_ciphertext = v_ciphertext, credential_iv = v_iv,
          sender_name = nullif(trim(p_sender_name), ''), monthly_limit = v_effective_monthly_limit,
          is_active = v_effective_active, last_tested_at = case when v_changed then null else v_account.last_tested_at end,
          last_balance_checked_at = case when v_changed then null else v_account.last_balance_checked_at end,
          last_provider_balance = case when v_changed then null else v_account.last_provider_balance end,
          last_error = case when v_changed then 'بانتظار فحص حساب TweetSMS واسم المرسل بعد تغيير الإعداد.' else v_account.last_error end,
          updated_by_user_id = p_user_id, updated_at = now()
      where a.id = v_account.id
      returning a.id, a.tenant_id, a.is_active into account_id, tenant_id, is_active;
  else
    if nullif(trim(p_credential_ciphertext), '') is null or nullif(trim(p_credential_iv), '') is null then raise exception 'TWEETSMS_CREDENTIALS_REQUIRED' using errcode = 'P0001'; end if;
    v_changed := true;
    is_active := false;
    insert into public.tenant_tweetsms_accounts as a(
      tenant_id, api_endpoint, credential_ciphertext, credential_iv, sender_name, monthly_limit, is_active, last_error, created_by_user_id, updated_by_user_id
    ) values (
      p_tenant_id, trim(p_api_endpoint), p_credential_ciphertext, p_credential_iv, nullif(trim(p_sender_name), ''), v_effective_monthly_limit, false,
      'بانتظار فحص حساب TweetSMS واسم المرسل قبل التفعيل.', p_user_id, p_user_id
    ) returning a.id, a.tenant_id, a.is_active into account_id, tenant_id, is_active;
  end if;

  insert into public.audit_logs(tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, before_data, after_data, metadata)
    values (
      p_tenant_id, v_site_id, p_user_id, (select platform_role from public.users where id = p_user_id),
      'tenant_tweetsms_account', account_id::text, 'tweetsms_account_saved',
      case when v_exists then jsonb_build_object('configured', true) else null end,
      jsonb_build_object('configured', true, 'apiEndpoint', trim(p_api_endpoint), 'senderName', nullif(trim(p_sender_name), ''), 'monthlyLimit', v_effective_monthly_limit, 'isActive', is_active),
      jsonb_build_object('credentialsChanged', v_changed, 'activationRequired', (v_changed or (p_is_active and not is_active)))
    );
  activation_required := v_changed or (p_is_active and not is_active);
  return next;
end;
$$;


create or replace function public.powerhub_record_tenant_tweetsms_test(
  p_user_id bigint,
  p_tenant_id bigint,
  p_expected_updated_at timestamptz,
  p_success boolean,
  p_balance integer,
  p_error text
)
returns table (account_id bigint, is_active boolean, last_provider_balance integer, last_tested_at timestamptz, last_error text)
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  v_account public.tenant_tweetsms_accounts%rowtype;
  v_site_id bigint;
begin
  perform 1 from public.users
    where id = p_user_id and account_status = 'active' and platform_role in ('platform_owner', 'platform_admin');
  if not found then raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode = 'P0001'; end if;
  select id into v_site_id from public.sites where tenant_id = p_tenant_id and is_active = true order by id limit 1;
  if v_site_id is null then raise exception 'TENANT_SITE_REQUIRED' using errcode = 'P0001'; end if;
  select * into v_account from public.tenant_tweetsms_accounts where tenant_tweetsms_accounts.tenant_id = p_tenant_id for update;
  if not found then raise exception 'TWEETSMS_ACCOUNT_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_account.updated_at is distinct from p_expected_updated_at then raise exception 'TWEETSMS_CONFIGURATION_CHANGED' using errcode = 'P0001'; end if;

  update public.tenant_tweetsms_accounts as a
    set last_tested_at = now(),
        last_provider_balance = case when p_balance is null then a.last_provider_balance else p_balance end,
        last_balance_checked_at = case when p_balance is null then a.last_balance_checked_at else now() end,
        last_error = case when p_success then null else coalesce(nullif(left(trim(p_error), 2000), ''), 'فشل فحص TweetSMS.') end,
        is_active = case when p_success then a.is_active else false end,
        updated_by_user_id = p_user_id, updated_at = now()
    where a.id = v_account.id
    returning a.id, a.is_active, a.last_provider_balance, a.last_tested_at, a.last_error
    into account_id, is_active, last_provider_balance, last_tested_at, last_error;

  insert into public.audit_logs(tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, metadata)
    values (
      p_tenant_id, v_site_id, p_user_id, (select platform_role from public.users where id = p_user_id),
      'tenant_tweetsms_account', account_id::text, 'tweetsms_account_tested',
      jsonb_build_object('success', p_success, 'balanceAvailable', p_balance is not null)
    );
  return next;
end;
$$;


revoke execute on function public.powerhub_save_tenant_tweetsms_account(bigint, bigint, text, text, text, text, integer, boolean) from public, anon, authenticated;
revoke execute on function public.powerhub_record_tenant_tweetsms_test(bigint, bigint, timestamptz, boolean, integer, text) from public, anon, authenticated;
grant execute on function public.powerhub_save_tenant_tweetsms_account(bigint, bigint, text, text, text, text, integer, boolean) to service_role;
grant execute on function public.powerhub_record_tenant_tweetsms_test(bigint, bigint, timestamptz, boolean, integer, text) to service_role;
