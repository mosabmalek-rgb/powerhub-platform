create or replace function public.powerhub_admin_save_platform_setting(
  p_actor_user_id bigint,
  p_setting_key text,
  p_is_enabled boolean,
  p_message text default null,
  p_value jsonb default null,
  p_has_value boolean default false
)
returns table(success boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.users%rowtype;
  v_severity text := case when p_setting_key = 'maintenance_mode' then 'warning' else 'info' end;
begin
  if p_setting_key is null or length(trim(p_setting_key)) < 2 or length(trim(p_setting_key)) > 100 then
    raise exception 'INVALID_SETTING_KEY';
  end if;

  if p_message is not null and char_length(p_message) > 4000 then
    raise exception 'INVALID_SETTING_MESSAGE';
  end if;

  select *
    into v_actor
    from public.users
   where id = p_actor_user_id
     and role = 'admin'
     and platform_role in ('platform_owner', 'platform_admin')
     and account_status = 'active'
   for update;

  if not found then
    raise exception 'FORBIDDEN';
  end if;

  if p_has_value then
    insert into public.platform_settings(
      setting_key, is_enabled, value, message, updated_by_user_id, updated_at
    )
    values (
      trim(p_setting_key), p_is_enabled, p_value, p_message, v_actor.id, now()
    )
    on conflict (setting_key) do update
      set is_enabled = excluded.is_enabled,
          value = excluded.value,
          message = excluded.message,
          updated_by_user_id = excluded.updated_by_user_id,
          updated_at = now();
  else
    insert into public.platform_settings(
      setting_key, is_enabled, message, updated_by_user_id, updated_at
    )
    values (
      trim(p_setting_key), p_is_enabled, p_message, v_actor.id, now()
    )
    on conflict (setting_key) do update
      set is_enabled = excluded.is_enabled,
          message = excluded.message,
          updated_by_user_id = excluded.updated_by_user_id,
          updated_at = now();
  end if;

  insert into public.platform_security_events(
    event_type, severity, status, title, details, metadata, created_by_user_id
  )
  values (
    'security_change',
    v_severity,
    'success',
    'تحديث إعداد المنصة',
    'تم تحديث إعداد منصة عبر مسار Supabase الإداري.',
    jsonb_build_object(
      'settingKey', trim(p_setting_key),
      'isEnabled', p_is_enabled,
      'hasValue', p_has_value
    ),
    v_actor.id
  );

  return query select true;
end;
$$;

revoke all on function public.powerhub_admin_save_platform_setting(bigint, text, boolean, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.powerhub_admin_save_platform_setting(bigint, text, boolean, text, jsonb, boolean) to service_role;
