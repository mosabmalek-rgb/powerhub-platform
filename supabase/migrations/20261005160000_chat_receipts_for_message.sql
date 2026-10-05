create or replace function public.chat_receipts_for_message(p_message_id bigint)
returns setof public.chat_message_receipts
language sql security definer set search_path=''
as $function$
  select r.*
  from public.chat_message_receipts r
  where r.message_id=p_message_id
    and exists (
      select 1 from public.chat_messages m
      join public.chat_conversations c on c.id=m.conversation_id
      where m.id=p_message_id
        and (
          exists (select 1 from public.tenant_members tm where tm.tenant_id=c.tenant_id and tm.user_id=(select auth.uid()::bigint) and tm.is_active=true)
          or exists (select 1 from public.users u where u.id=(select auth.uid()::bigint) and u.platform_role is not null)
        )
    )
  order by r.id;
$function$;
revoke all on function public.chat_receipts_for_message(bigint) from public,anon;
grant execute on function public.chat_receipts_for_message(bigint) to authenticated,service_role;