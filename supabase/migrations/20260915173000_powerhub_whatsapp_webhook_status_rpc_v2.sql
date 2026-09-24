-- WhatsApp webhook status persistence v2.
-- Keep the privileged implementation private and expose only a service-role wrapper.

create or replace function private.powerhub_process_whatsapp_status(
  p_tenant_id bigint,
  p_provider_message_id text,
  p_status text
)
returns table(
  updated boolean,
  notification_id bigint,
  status text
)
language plpgsql
security definer
set search_path = ''
volatile
as $$
begin
  if p_tenant_id is null or p_tenant_id <= 0 then
    raise exception 'INVALID_TENANT_ID' using errcode = '22023';
  end if;
  if p_provider_message_id is null or length(trim(p_provider_message_id)) = 0 then
    raise exception 'INVALID_PROVIDER_MESSAGE_ID' using errcode = '22023';
  end if;
  if p_status not in ('submitted', 'delivered', 'read', 'failed') then
    raise exception 'INVALID_NOTIFICATION_STATUS' using errcode = '22023';
  end if;

  return query
  update public.notification_messages as nm
     set status = p_status, updated_at = now()
   where nm.tenant_id = p_tenant_id
     and nm.provider_message_id = p_provider_message_id
     and (
       nm.status = p_status
       or (p_status = 'delivered' and nm.status = 'submitted')
       or (p_status = 'read' and nm.status in ('submitted', 'delivered'))
       or (p_status = 'failed' and nm.status = 'submitted')
     )
  returning true, nm.id, nm.status;

  if not found then
    return query
    select false, nm.id, nm.status
    from public.notification_messages as nm
    where nm.tenant_id = p_tenant_id
      and nm.provider_message_id = p_provider_message_id
    limit 1;
  end if;
end;
$$;

create or replace function public.powerhub_process_whatsapp_status(
  bigint, text, text
)
returns table(updated boolean, notification_id bigint, status text)
language sql
security definer
set search_path = ''
volatile
as $$
  select * from private.powerhub_process_whatsapp_status($1, $2, $3);
$$;

revoke all on function private.powerhub_process_whatsapp_status(bigint, text, text) from public, anon, authenticated;
revoke all on function public.powerhub_process_whatsapp_status(bigint, text, text) from public, anon, authenticated;
grant execute on function public.powerhub_process_whatsapp_status(bigint, text, text) to service_role;
