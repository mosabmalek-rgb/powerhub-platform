-- Reconcile production AI knowledge search ranking and Arabic matching.
create or replace function public.chat_ai_search_knowledge(
  p_query text, p_category text default null, p_limit integer default 5,
  p_tenant_id bigint default null, p_user_id uuid default null
)
returns table(article_id bigint,title text,primary_question text,alternative_questions jsonb,answer text,category text,linked_route text,related_operation text,score real)
language plpgsql stable security definer set search_path=''
as $function$
declare
 v_limit integer:=greatest(1,least(coalesce(p_limit,5),12));
 v_query text:=nullif(btrim(coalesce(p_query,'')),'');
 v_normalized_query text;
 v_app_user_id bigint;
begin
 if p_user_id is null or p_tenant_id is null then raise exception 'UNAUTHORIZED'; end if;
 select u.id into v_app_user_id from public.users u where u.auth_user_id=p_user_id;
 if v_app_user_id is null then raise exception 'UNAUTHORIZED'; end if;
 if not exists(select 1 from public.tenant_members tm where tm.user_id=v_app_user_id and tm.tenant_id=p_tenant_id and tm.is_active=true and tm.membership_status='active' and (tm.expires_at is null or tm.expires_at>now())) then raise exception 'FORBIDDEN'; end if;
 if v_query is null then return; end if;
 v_normalized_query := regexp_replace(lower(translate(v_query,'أإآةى','اااهيي')),'[[:space:]]+',' ','g');
 return query
 select a.id,a.title,a.primary_question,a.alternative_questions,a.answer,a.category,a.linked_route,a.related_operation,
 (case when to_tsvector('simple',coalesce(a.title,'')||' '||coalesce(a.primary_question,'')||' '||coalesce(a.alternative_questions::text,'')||' '||coalesce(a.search_aliases,'')||' '||coalesce(a.answer,'')) @@ plainto_tsquery('simple',v_query) then 1.0 else 0.0 end
 + case when lower(translate(coalesce(a.title,'')||' '||coalesce(a.primary_question,'')||' '||coalesce(a.search_aliases,'')||' '||coalesce(a.answer,''),'أإآةى','اااهيي')) like '%'||replace(v_normalized_query,' ','%')||'%' then 1.0 else 0.0 end)::real
 from public.chat_knowledge_articles a
 where a.status='published'
 and (p_category is null or a.category=p_category)
 and (to_tsvector('simple',coalesce(a.title,'')||' '||coalesce(a.primary_question,'')||' '||coalesce(a.alternative_questions::text,'')||' '||coalesce(a.search_aliases,'')||' '||coalesce(a.answer,'')) @@ plainto_tsquery('simple',v_query)
      or lower(translate(coalesce(a.title,'')||' '||coalesce(a.primary_question,'')||' '||coalesce(a.search_aliases,'')||' '||coalesce(a.answer,''),'أإآةى','اااهيي')) like '%'||replace(v_normalized_query,' ','%')||'%')
 order by 9 desc,a.updated_at desc,a.id desc limit v_limit;
end;$function$;
revoke all on function public.chat_ai_search_knowledge(text,text,integer,bigint,uuid) from public,anon,authenticated;
grant execute on function public.chat_ai_search_knowledge(text,text,integer,bigint,uuid) to service_role;