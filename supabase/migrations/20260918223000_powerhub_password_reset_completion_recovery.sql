create or replace function public.powerhub_recover_password_reset_completion(
  p_intent_id bigint,
  p_actor_user_id bigint
)
returns table(success boolean, intent_status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_intent public.password_reset_intents%rowtype;
begin
  select *
    into v_intent
  from public.password_reset_intents
  where id = p_intent_id
  for update;

  if not found then
    raise exception 'PASSWORD_RESET_INTENT_NOT_FOUND' using errcode='P0002';
  end if;

  if v_intent.actor_user_id <> p_actor_user_id then
    raise exception 'PASSWORD_RESET_ACTOR_MISMATCH' using errcode='42501';
  end if;

  if v_intent.status = 'completed' then
    return query select true, 'completed'::text;
    return;
  end if;

  if v_intent.status <> 'in_progress' then
    raise exception 'PASSWORD_RESET_INTENT_NOT_ACTIVE' using errcode='P0001';
  end if;

  if not exists (
    select 1
    from public.users u
    where u.id = v_intent.target_user_id
      and u.auth_user_id = v_intent.target_auth_user_id
  ) then
    raise exception 'PASSWORD_RESET_TARGET_CHANGED' using errcode='P0002';
  end if;

  update public.users
  set must_change_password = true,
      temporary_password_issued_at = now(),
      updated_at = now()
  where id = v_intent.target_user_id
    and auth_user_id = v_intent.target_auth_user_id;

  if not found then
    raise exception 'PASSWORD_RESET_TARGET_CHANGED' using errcode='P0002';
  end if;

  update public.password_reset_intents
  set status = 'completed',
      failure_reason = null,
      completed_at = now()
  where id = p_intent_id;

  return query select true, 'completed'::text;
end;
$function$;

revoke all on function public.powerhub_recover_password_reset_completion(bigint,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_recover_password_reset_completion(bigint,bigint) to service_role;
