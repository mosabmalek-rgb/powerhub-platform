-- PowerHub Chat / Helpdesk admin controls.
-- All mutation paths derive identity from auth.uid() and require manageSupportChat.

create or replace function private.chat_assert_support_admin()
returns bigint
language plpgsql
security definer
set search_path=''
stable
as $$
declare v_user bigint;
begin
  v_user := private.chat_current_user_id();
  if v_user is null then raise exception 'UNAUTHORIZED'; end if;
  if not private.powerhub_has_platform_capability('manageSupportChat') then raise exception 'FORBIDDEN'; end if;
  return v_user;
end;
$$;

revoke all on function private.chat_assert_support_admin() from public,anon,authenticated;

create or replace function public.chat_support_admin_snapshot()
returns jsonb
language plpgsql
security invoker
set search_path=''
stable
as $$
begin
  perform private.chat_assert_support_admin();
  return jsonb_build_object(
    'settings',
      coalesce((select to_jsonb(s) from public.chat_support_settings s where s.id=true),
               jsonb_build_object('id',true,'auto_close_after_minutes',2880,'reopen_window_minutes',10080)),
    'sla',
      coalesce((select jsonb_agg(to_jsonb(s) order by case s.priority when 'urgent' then 1 when 'high' then 2 when 'normal' then 3 else 4 end)
                from public.chat_support_sla_policies s),'[]'::jsonb),
    'categories',
      coalesce((select jsonb_agg(to_jsonb(s) order by s.sort_order,s.name)
                from public.chat_support_categories s),'[]'::jsonb),
    'tags',
      coalesce((select jsonb_agg(to_jsonb(s) order by s.name)
                from public.chat_support_tags s),'[]'::jsonb),
    'quickReplies',
      coalesce((select jsonb_agg(to_jsonb(s) order by s.is_active desc,s.title)
                from public.chat_support_quick_replies s),'[]'::jsonb)
  );
end;
$$;

revoke execute on function public.chat_support_admin_snapshot() from public,anon;
grant execute on function public.chat_support_admin_snapshot() to authenticated;

create or replace function public.chat_support_admin_save_settings(
  p_auto_close_after_minutes integer,
  p_reopen_window_minutes integer
)
returns public.chat_support_settings
language plpgsql
security invoker
set search_path=''
volatile
as $$
declare v_user bigint; v_row public.chat_support_settings;
begin
  v_user := private.chat_assert_support_admin();
  if p_auto_close_after_minutes < 0 or p_auto_close_after_minutes > 43200 then raise exception 'INVALID_AUTO_CLOSE'; end if;
  if p_reopen_window_minutes < 60 or p_reopen_window_minutes > 43200 then raise exception 'INVALID_REOPEN_WINDOW'; end if;

  insert into public.chat_support_settings(id,auto_close_after_minutes,reopen_window_minutes,updated_by_user_id,updated_at)
  values(true,p_auto_close_after_minutes,p_reopen_window_minutes,v_user,now())
  on conflict(id) do update
    set auto_close_after_minutes=excluded.auto_close_after_minutes,
        reopen_window_minutes=excluded.reopen_window_minutes,
        updated_by_user_id=excluded.updated_by_user_id,
        updated_at=now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.chat_support_admin_save_settings(integer,integer) from public,anon;
grant execute on function public.chat_support_admin_save_settings(integer,integer) to authenticated;

create or replace function public.chat_support_admin_upsert_category(
  p_code text,
  p_name text,
  p_description text default null,
  p_first_response_minutes integer default 60,
  p_resolution_minutes integer default 1440,
  p_sort_order integer default 100,
  p_is_active boolean default true
)
returns public.chat_support_categories
language plpgsql
security invoker
set search_path=''
volatile
as $$
declare v_row public.chat_support_categories;
begin
  perform private.chat_assert_support_admin();

  if nullif(btrim(p_code),'') is null or p_code !~ '^[a-z0-9_]+$' then raise exception 'INVALID_CATEGORY_CODE'; end if;
  if nullif(btrim(p_name),'') is null then raise exception 'INVALID_CATEGORY_NAME'; end if;
  if p_first_response_minutes < 1 or p_first_response_minutes > 43200 then raise exception 'INVALID_FIRST_RESPONSE'; end if;
  if p_resolution_minutes < 1 or p_resolution_minutes > 129600 then raise exception 'INVALID_RESOLUTION'; end if;

  insert into public.chat_support_categories(
    code,name,description,default_first_response_minutes,default_resolution_minutes,sort_order,is_active
  )
  values(
    lower(btrim(p_code)),btrim(p_name),nullif(btrim(p_description),''),
    p_first_response_minutes,p_resolution_minutes,coalesce(p_sort_order,100),coalesce(p_is_active,true)
  )
  on conflict(code) do update
    set name=excluded.name,
        description=excluded.description,
        default_first_response_minutes=excluded.default_first_response_minutes,
        default_resolution_minutes=excluded.default_resolution_minutes,
        sort_order=excluded.sort_order,
        is_active=excluded.is_active,
        updated_at=now()
  returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.chat_support_admin_upsert_category(text,text,text,integer,integer,integer,boolean) from public,anon;
grant execute on function public.chat_support_admin_upsert_category(text,text,text,integer,integer,integer,boolean) to authenticated;

create or replace function public.chat_support_admin_upsert_tag(
  p_code text,
  p_name text,
  p_color text default '#64748B',
  p_is_active boolean default true
)
returns public.chat_support_tags
language plpgsql
security invoker
set search_path=''
volatile
as $$
declare v_row public.chat_support_tags;
begin
  perform private.chat_assert_support_admin();
  if nullif(btrim(p_code),'') is null or p_code !~ '^[a-z0-9_-]+$' then raise exception 'INVALID_TAG_CODE'; end if;
  if nullif(btrim(p_name),'') is null then raise exception 'INVALID_TAG_NAME'; end if;
  if coalesce(p_color,'') !~ '^#[0-9A-Fa-f]{6}$' then raise exception 'INVALID_TAG_COLOR'; end if;

  insert into public.chat_support_tags(code,name,color,is_active)
  values(lower(btrim(p_code)),btrim(p_name),p_color,coalesce(p_is_active,true))
  on conflict(code) do update
    set name=excluded.name,color=excluded.color,is_active=excluded.is_active,updated_at=now()
  returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.chat_support_admin_upsert_tag(text,text,text,boolean) from public,anon;
grant execute on function public.chat_support_admin_upsert_tag(text,text,text,boolean) to authenticated;

create or replace function public.chat_support_admin_upsert_quick_reply(
  p_shortcut text,
  p_title text,
  p_body text,
  p_category_code text default null,
  p_is_active boolean default true
)
returns public.chat_support_quick_replies
language plpgsql
security invoker
set search_path=''
volatile
as $$
declare v_user bigint; v_row public.chat_support_quick_replies;
begin
  v_user := private.chat_assert_support_admin();
  if nullif(btrim(p_shortcut),'') is null or p_shortcut !~ '^[a-z0-9_-]+$' then raise exception 'INVALID_SHORTCUT'; end if;
  if nullif(btrim(p_title),'') is null then raise exception 'INVALID_REPLY_TITLE'; end if;
  if nullif(btrim(p_body),'') is null or length(p_body) > 8000 then raise exception 'INVALID_REPLY_BODY'; end if;
  if p_category_code is not null and not exists(select 1 from public.chat_support_categories where code=p_category_code) then raise exception 'INVALID_REPLY_CATEGORY'; end if;

  insert into public.chat_support_quick_replies(
    category_code,shortcut,title,body,is_active,created_by_user_id,updated_by_user_id,updated_at
  )
  values(
    nullif(btrim(p_category_code),''),lower(btrim(p_shortcut)),btrim(p_title),btrim(p_body),
    coalesce(p_is_active,true),v_user,v_user,now()
  )
  on conflict(shortcut) do update
    set category_code=excluded.category_code,
        title=excluded.title,
        body=excluded.body,
        is_active=excluded.is_active,
        updated_by_user_id=v_user,
        updated_at=now()
  returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.chat_support_admin_upsert_quick_reply(text,text,text,text,boolean) from public,anon;
grant execute on function public.chat_support_admin_upsert_quick_reply(text,text,text,text,boolean) to authenticated;

create or replace function public.chat_support_admin_upsert_sla(
  p_priority text,
  p_multiplier numeric
)
returns public.chat_support_sla_policies
language plpgsql
security invoker
set search_path=''
volatile
as $$
declare v_row public.chat_support_sla_policies;
begin
  perform private.chat_assert_support_admin();
  if p_priority not in ('low','normal','high','urgent') then raise exception 'INVALID_PRIORITY'; end if;
  if p_multiplier <= 0 or p_multiplier > 10 then raise exception 'INVALID_MULTIPLIER'; end if;

  insert into public.chat_support_sla_policies(priority,multiplier,updated_at)
  values(p_priority,round(p_multiplier,3),now())
  on conflict(priority) do update
    set multiplier=excluded.multiplier,updated_at=now()
  returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.chat_support_admin_upsert_sla(text,numeric) from public,anon;
grant execute on function public.chat_support_admin_upsert_sla(text,numeric) to authenticated;
