create or replace function public.powerhub_admin_create_sms_plan(
  p_actor_user_id bigint,
  p_code text,
  p_name text,
  p_description text,
  p_included_messages integer,
  p_is_active boolean
)
returns table(id bigint, code text, name text, description text, included_messages integer, is_active boolean, created_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
begin
  select u.platform_role into v_role
  from public.users u
  where u.id = p_actor_user_id and u.role = 'admin' and u.account_status = 'active';
  if v_role not in ('platform_owner','platform_admin') then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if trim(coalesce(p_code,'')) = '' or trim(coalesce(p_name,'')) = '' or coalesce(p_included_messages,0) < 0 then raise exception 'INVALID_PLAN'; end if;

  insert into public.platform_sms_plans(code,name,description,included_messages,is_active,created_at,updated_at)
  values(lower(trim(p_code)),trim(p_name),nullif(trim(p_description),''),coalesce(p_included_messages,0),coalesce(p_is_active,true),now(),now())
  returning platform_sms_plans.id, platform_sms_plans.code, platform_sms_plans.name, platform_sms_plans.description,
            platform_sms_plans.included_messages, platform_sms_plans.is_active, platform_sms_plans.created_at, platform_sms_plans.updated_at
  into id, code, name, description, included_messages, is_active, created_at, updated_at;

  insert into public.platform_security_events(event_type,severity,status,title,created_by_user_id,metadata,created_at)
  values('security_change','info','success','إنشاء باقة رسائل SMS',p_actor_user_id,
         jsonb_build_object('planId',id,'code',code,'includedMessages',included_messages),now());
  return next;
exception when unique_violation then
  raise exception 'DUPLICATE_CODE';
end;
$$;

create or replace function public.powerhub_admin_update_sms_plan(
  p_actor_user_id bigint,
  p_id bigint,
  p_name text,
  p_description text,
  p_included_messages integer,
  p_is_active boolean
)
returns table(id bigint, code text, name text, description text, included_messages integer, is_active boolean, created_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
begin
  select u.platform_role into v_role
  from public.users u
  where u.id = p_actor_user_id and u.role = 'admin' and u.account_status = 'active';
  if v_role not in ('platform_owner','platform_admin') then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if p_id is null or p_id <= 0 or (p_included_messages is not null and p_included_messages < 0) then raise exception 'INVALID_PLAN'; end if;

  update public.platform_sms_plans
  set name = coalesce(nullif(trim(p_name),''), name),
      description = case when p_description is null then description else nullif(trim(p_description),'') end,
      included_messages = coalesce(p_included_messages, included_messages),
      is_active = coalesce(p_is_active, is_active),
      updated_at = now()
  where platform_sms_plans.id = p_id;
  if not found then raise exception 'PLAN_NOT_FOUND'; end if;

  select p.* into id, code, name, description, included_messages, is_active, created_at, updated_at
  from public.platform_sms_plans p where p.id = p_id;

  insert into public.platform_security_events(event_type,severity,status,title,created_by_user_id,metadata,created_at)
  values('security_change','info','success','تحديث باقة رسائل SMS',p_actor_user_id,jsonb_build_object('planId',p_id),now());
  return next;
end;
$$;

revoke all on function public.powerhub_admin_create_sms_plan(bigint,text,text,text,integer,boolean) from public;
revoke all on function public.powerhub_admin_create_sms_plan(bigint,text,text,text,integer,boolean) from anon;
revoke all on function public.powerhub_admin_create_sms_plan(bigint,text,text,text,integer,boolean) from authenticated;
revoke all on function public.powerhub_admin_update_sms_plan(bigint,bigint,text,text,integer,boolean) from public;
revoke all on function public.powerhub_admin_update_sms_plan(bigint,bigint,text,text,integer,boolean) from anon;
revoke all on function public.powerhub_admin_update_sms_plan(bigint,bigint,text,text,integer,boolean) from authenticated;
grant execute on function public.powerhub_admin_create_sms_plan(bigint,text,text,text,integer,boolean) to service_role;
grant execute on function public.powerhub_admin_update_sms_plan(bigint,bigint,text,text,integer,boolean) to service_role;
