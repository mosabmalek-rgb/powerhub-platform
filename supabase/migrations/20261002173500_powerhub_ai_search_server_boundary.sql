-- AI knowledge retrieval is an internal server boundary.
-- The server supplies the already-authorized actor/tenant; browser roles have no EXECUTE.

create or replace function public.chat_ai_search_knowledge(
  p_query text,
  p_category text default null,
  p_limit integer default 5
)
returns table(
  article_id bigint,
  title text,
  primary_question text,
  alternative_questions jsonb,
  answer text,
  category text,
  linked_route text,
  related_operation text,
  score real
)
language plpgsql
security definer
set search_path=''
stable
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit,5),12));
  v_query text := nullif(btrim(coalesce(p_query,'')),'');
begin
  if coalesce(current_setting('request.jwt.claim.role', true),'') <> 'service_role' then
    raise exception 'INTERNAL_ONLY';
  end if;

  if v_query is null then return; end if;

  return query
  select
    a.id,
    a.title,
    a.primary_question,
    a.alternative_questions,
    a.answer,
    a.category,
    a.linked_route,
    a.related_operation,
    ts_rank_cd(
      to_tsvector(
        'simple',
        coalesce(a.title,'') || ' ' ||
        coalesce(a.primary_question,'') || ' ' ||
        coalesce(a.alternative_questions::text,'') || ' ' ||
        coalesce(a.search_aliases,'') || ' ' ||
        coalesce(a.answer,'')
      ),
      plainto_tsquery('simple', v_query)
    )::real
  from public.chat_knowledge_articles a
  where a.status='published'
    and (p_category is null or a.category=p_category)
    and to_tsvector(
      'simple',
      coalesce(a.title,'') || ' ' ||
      coalesce(a.primary_question,'') || ' ' ||
      coalesce(a.alternative_questions::text,'') || ' ' ||
      coalesce(a.search_aliases,'') || ' ' ||
      coalesce(a.answer,'')
    ) @@ plainto_tsquery('simple', v_query)
  order by 10 desc, a.updated_at desc, a.id desc
  limit v_limit;
end;
$$;

revoke all on function public.chat_ai_search_knowledge(text,text,integer) from public,anon,authenticated;
grant execute on function public.chat_ai_search_knowledge(text,text,integer) to service_role;
