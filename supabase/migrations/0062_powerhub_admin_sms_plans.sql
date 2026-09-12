create or replace function public.powerhub_admin_create_sms_plan(
  p_actor_user_id bigint,
  p_code text,
  p_name text,
  p_description text default null,
  p_included_messages integer default 0,
  p_is_active boolean default true
)
returns table (id bigint, code text, name text, description text, included_messages integer, is_active boolean, created_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan public.platform_sms_plans%rowtype;
begin
  if not exists (
    select 1 from public.users
    where id = p_actor_user_id
      and role = 'admin'
      and account_status = 'active'
      and platform_role in ('platform_owner', 'platform_admin')
  ) then
    raise exception 'PLATFORM_ADMIN_REQUIRED';
  end if;

  if coalesce(length(trim(p_code)), 0) < 2 or length(trim(p_code)) > 80 then
    raise exception 'INVALID_CODE';
  end if;
  if coalesce(length(trim(p_name)), 0) < 2 or length(trim(p_name)) > 160 then
    raise exception 'INVALID_NAME';
  end if;
  if p_description is not null and length(p_description) > 1000 then
    raise exception 'INVALID_DESCRIPTION';
  end if;
  if p_included_messages is null or p_included_messages < 0 or p_included_messages > 100000000 then
    raise exception 'INVALID_INCLUDED_MESSAGES';
  end if;

  insert into public.platform_sms_plans (code, name, description, included_messages, is_active)
  values (trim(p_code), trim(p_name), nullif(trim(p_description), ''), p_included_messages, coalesce(p_is_active, true))
  returning * into v_plan;

  insert into public.platform_security_events (
    event_type, severity, status, title, details, metadata, created_by_user_id
  ) values (
    'security_change', 'info', 'success', 'إنشاء باقة رسائل SMS',
    'تم إنشاء باقة الرسائل عبر مسار Supabase الإداري الذري.',
    jsonb_build_object('planId', v_plan.id, 'code', v_plan.code, 'includedMessages', v_plan.included_messages),
    p_actor_user_id
  );

  return query select v_plan.id, v_plan.code, v_plan.name, v_plan.description, v_plan.included_messages, v_plan.is_active, v_plan.created_at, v_plan.updated_at;
exception
  when unique_violation then
    raise exception 'DUPLICATE_CODE';
end;
$$;

create or replace function public.powerhub_admin_update_sms_plan(
  p_actor_user_id bigint,
  p_id bigint,
  p_name text default null,
  p_description text default null,
  p_included_messages integer default null,
  p_is_active boolean default null
)
returns table (id bigint, code text, name text, description text, included_messages integer, is_active boolean, created_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan public.platform_sms_plans%rowtype;
begin
  if not exists (
    select 1 from public.users
    where id = p_actor_user_id
      and role = 'admin'
      and account_status = 'active'
      and platform_role in ('platform_owner', 'platform_admin')
  ) then
    raise exception 'PLATFORM_ADMIN_REQUIRED';
  end if;
  if p_id is null or p_id <= 0 then raise exception 'INVALID_ID'; end if;
  if p_name is not null and (length(trim(p_name)) < 2 or length(trim(p_name)) > 160) then raise exception 'INVALID_NAME'; end if;
  if p_description is not null and length(p_description) > 1000 then raise exception 'INVALID_DESCRIPTION'; end if;
  if p_included_messages is not null and (p_included_messages < 0 or p_included_messages > 100000000) then raise exception 'INVALID_INCLUDED_MESSAGES'; end if;

  update public.platform_sms_plans
  set name = coalesce(trim(p_name), name),
      description = case when p_description is null then description else nullif(trim(p_description), '') end,
      included_messages = coalesce(p_included_messages, included_messages),
      is_active = coalesce(p_is_active, is_active),
      updated_at = now()
  where id = p_id
  returning * into v_plan;

  if not found then raise exception 'PLAN_NOT_FOUND'; end if;

  insert into public.platform_security_events (
    event_type, severity, status, title, details, metadata, created_by_user_id
  ) values (
    'security_change', 'info', 'success', 'تحديث باقة رسائل SMS',
    'تم تحديث باقة الرسائل عبر مسار Supabase الإداري الذري.',
    jsonb_build_object('planId', v_plan.id, 'code', v_plan.code, 'includedMessages', v_plan.included_messages, 'isActive', v_plan.is_active),
    p_actor_user_id
  );

  return query select v_plan.id, v_plan.code, v_plan.name, v_plan.description, v_plan.included_messages, v_plan.is_active, v_plan.created_at, v_plan.updated_at;
end;
$$;

revoke all on function public.powerhub_admin_create_sms_plan(bigint, text, text, text, integer, boolean) from public, anon, authenticated;
grant execute on function public.powerhub_admin_create_sms_plan(bigint, text, text, text, integer, boolean) to service_role;
revoke all on function public.powerhub_admin_update_sms_plan(bigint, bigint, text, text, integer, boolean) from public, anon, authenticated;
grant execute on function public.powerhub_admin_update_sms_plan(bigint, bigint, text, text, integer, boolean) to service_role;
