-- Fix automation lifecycle RPC output handling.
-- PL/pgSQL UPDATE ... RETURNING must capture returned values; otherwise the
-- enable/disable/archive buttons fail when the RPC executes.
create or replace function public.powerhub_unified_messaging_set_automation_state(
  p_tenant_id bigint,
  p_site_id bigint,
  p_automation_id bigint,
  p_enabled boolean,
  p_archived boolean,
  p_actor_user_id bigint
)
returns table(id bigint, enabled boolean, archived_at timestamptz)
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_id bigint;
  v_enabled boolean;
  v_archived_at timestamptz;
begin
  update public.powerhub_message_automations as automation
  set enabled = case when p_archived then false else p_enabled end,
      archived_at = case when p_archived then now() else null end,
      updated_by = p_actor_user_id,
      updated_at = now()
  where automation.id = p_automation_id
    and automation.tenant_id = p_tenant_id
    and automation.site_id = p_site_id
  returning automation.id, automation.enabled, automation.archived_at
    into v_id, v_enabled, v_archived_at;

  if not found then
    raise exception 'AUTOMATION_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  id := v_id;
  enabled := v_enabled;
  archived_at := v_archived_at;
  return next;
end;
$function$;

revoke execute on function public.powerhub_unified_messaging_set_automation_state(bigint,bigint,bigint,boolean,boolean,bigint)
  from public, anon, authenticated;
grant execute on function public.powerhub_unified_messaging_set_automation_state(bigint,bigint,bigint,boolean,boolean,bigint)
  to service_role;
