-- Support administrator conversation deletion with audit trail.
create or replace function public.chat_admin_delete_support_conversations(
  p_conversation_ids bigint[],
  p_actor_user_id bigint
)
returns table(deleted_count integer)
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_ids bigint[];
  v_requested integer;
  v_found integer;
  v_actor_role text;
  v_row record;
  v_deleted integer := 0;
begin
  select array_agg(distinct x order by x) into v_ids
  from unnest(coalesce(p_conversation_ids,'{}'::bigint[])) as x
  where x is not null and x > 0;

  v_requested := coalesce(array_length(v_ids,1),0);
  if v_requested = 0 then
    raise exception 'NO_CONVERSATIONS_SELECTED';
  end if;
  if v_requested > 100 then
    raise exception 'TOO_MANY_CONVERSATIONS';
  end if;

  select u.platform_role into v_actor_role
  from public.users u
  where u.id=p_actor_user_id
    and u.account_status='active'
    and exists (
      select 1 from private.platform_capability_policies p
      where p.platform_role=u.platform_role
        and p.capability='manageSupportChat'
        and p.is_allowed=true
    );

  if v_actor_role is null then
    raise exception 'FORBIDDEN';
  end if;

  select count(*)::integer into v_found
  from public.chat_conversations c
  where c.id = any(v_ids)
    and c.conversation_type='support';

  if v_found <> v_requested then
    raise exception 'CONVERSATION_NOT_FOUND_OR_OUT_OF_SCOPE';
  end if;

  for v_row in
    select c.id,c.tenant_id,c.ticket_number,c.subject,c.status,c.priority,c.category_code,c.created_by_user_id,c.created_at
    from public.chat_conversations c
    where c.id=any(v_ids)
      and c.conversation_type='support'
  loop
    insert into public.audit_logs(
      tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,metadata
    )
    values(
      v_row.tenant_id,null,p_actor_user_id,v_actor_role,
      'chat_conversation',v_row.id::text,'delete',
      jsonb_build_object(
        'id',v_row.id,
        'ticketNumber',v_row.ticket_number,
        'subject',v_row.subject,
        'status',v_row.status,
        'priority',v_row.priority,
        'categoryCode',v_row.category_code,
        'createdByUserId',v_row.created_by_user_id,
        'createdAt',v_row.created_at
      ),
      jsonb_build_object('source','powerhub_support_center','bulk',v_requested>1)
    );
  end loop;

  delete from public.chat_conversations
  where id=any(v_ids)
    and conversation_type='support';

  get diagnostics v_deleted = row_count;
  return query select v_deleted;
end;
$function$;

revoke all on function public.chat_admin_delete_support_conversations(bigint[],bigint) from public,anon,authenticated;
grant execute on function public.chat_admin_delete_support_conversations(bigint[],bigint) to service_role;
