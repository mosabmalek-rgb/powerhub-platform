create or replace function public.chat_ai_handoff(p_conversation_id bigint,p_user_message_id bigint,p_ai_message_id bigint,p_actor_user_id bigint,p_trigger text,p_reason text,p_summary text,p_category text default 'other',p_priority text default 'normal',p_current_page text default null)
returns public.chat_bot_handoffs language plpgsql security definer set search_path=''
as $function$
declare v_conversation public.chat_conversations; v_existing public.chat_bot_handoffs; v_handoff public.chat_bot_handoffs; v_ticket text; v_support_user bigint; v_category text;
begin
 select * into v_conversation from public.chat_conversations where id=p_conversation_id and conversation_type='assistant'; if not found then raise exception 'NOT_FOUND'; end if;
 if not exists(select 1 from public.tenant_members tm where tm.tenant_id=v_conversation.tenant_id and tm.user_id=p_actor_user_id and tm.is_active=true and tm.membership_status='active' and (tm.expires_at is null or tm.expires_at>now())) then raise exception 'FORBIDDEN'; end if;
 if p_user_message_id is not null and not exists(select 1 from public.chat_messages where id=p_user_message_id and conversation_id=p_conversation_id and sender_type='human' and sender_user_id=p_actor_user_id) then raise exception 'INVALID_USER_MESSAGE'; end if;
 if p_ai_message_id is not null and not exists(select 1 from public.chat_messages where id=p_ai_message_id and conversation_id=p_conversation_id and sender_type='assistant') then raise exception 'INVALID_AI_MESSAGE'; end if;
 if p_trigger not in ('unknown','insufficient_knowledge','sensitive','user_requested','repeated_failure') then raise exception 'INVALID_HANDOFF_TRIGGER'; end if;
 if p_priority not in ('low','normal','high','urgent') then raise exception 'INVALID_PRIORITY'; end if;
 select code into v_category from public.chat_support_categories where code=coalesce(nullif(btrim(p_category),''),'other') and is_active=true limit 1; v_category:=coalesce(v_category,'other');
 select * into v_existing from public.chat_bot_handoffs where conversation_id=p_conversation_id and user_message_id=p_user_message_id limit 1; if found then return v_existing; end if;
 v_ticket:=private.chat_support_ticket_number();
 begin
  insert into public.chat_bot_handoffs(conversation_id,tenant_id,trigger,reason,user_message_id,ai_message_id,summary,category,priority,current_page,context_snapshot)
  values(v_conversation.id,v_conversation.tenant_id,p_trigger,coalesce(nullif(btrim(p_reason),''),'لم يتم العثور على إجابة موثوقة.'),p_user_message_id,p_ai_message_id,nullif(btrim(p_summary),''),v_category,p_priority,nullif(left(btrim(coalesce(p_current_page,'')),200),''),jsonb_build_object('ticket_number',v_ticket,'source','powerhub_ai')) returning * into v_handoff;
 exception when unique_violation then select * into v_existing from public.chat_bot_handoffs where conversation_id=p_conversation_id and user_message_id=p_user_message_id limit 1; if found then return v_existing; end if; raise; end;
 update public.chat_conversations set conversation_type='support',status='SUPPORT_PENDING',ticket_number=coalesce(ticket_number,v_ticket),category_code=coalesce(category_code,v_category),source='assistant',last_customer_message_at=coalesce(last_customer_message_at,last_message_at,created_at),priority=p_priority,updated_at=now() where id=p_conversation_id;
 insert into public.chat_ticket_events(conversation_id,tenant_id,actor_user_id,event_type,from_status,to_status,from_priority,to_priority,metadata)
 values(p_conversation_id,v_conversation.tenant_id,p_actor_user_id,'status_changed',v_conversation.status,'SUPPORT_PENDING',v_conversation.priority,p_priority,jsonb_build_object('trigger',p_trigger,'reason',left(coalesce(p_reason,''),500),'handoff_id',v_handoff.id));
 for v_support_user in select id from public.users where id in (select s from private.chat_support_user_ids() as s) loop
  insert into public.chat_inbox_notifications(user_id,tenant_id,conversation_id,message_id,notification_type,title,body)
  values(v_support_user,v_conversation.tenant_id,p_conversation_id,p_ai_message_id,'support_update','طلب دعم جديد من مساعد PowerHub',coalesce(v_ticket,'تذكرة دعم') || ' — ' || left(coalesce(p_reason,'تحويل تلقائي للدعم'),180)) on conflict do nothing;
 end loop;
 return v_handoff;
end;$function$;
revoke all on function public.chat_ai_handoff(bigint,bigint,bigint,bigint,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.chat_ai_handoff(bigint,bigint,bigint,bigint,text,text,text,text,text,text) to service_role;
