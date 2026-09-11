create or replace function public.powerhub_process_whatsapp_status(
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
set search_path = public, pg_temp
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
     set status = p_status,
         updated_at = now()
   where nm.tenant_id = p_tenant_id
     and nm.provider_message_id = p_provider_message_id
  returning true, nm.id, nm.status;

  if not found then
    return query select false, null::bigint, null::text;
  end if;
end;
$$;

revoke all on function public.powerhub_process_whatsapp_status(bigint, text, text) from public, anon, authenticated;
grant execute on function public.powerhub_process_whatsapp_status(bigint, text, text) to service_role;
