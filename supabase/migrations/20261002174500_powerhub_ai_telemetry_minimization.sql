-- Minimize AI telemetry: never persist the full user question in the legacy question column.
create or replace function public.chat_ai_record_run(
  p_request_id uuid,
  p_conversation_id bigint,
  p_tenant_id bigint,
  p_user_id bigint,
  p_question_preview text,
  p_question_hash text,
  p_decision text,
  p_model text,
  p_top_retrieval_score real,
  p_retrieved_article_ids bigint[],
  p_handoff_id bigint,
  p_latency_ms integer,
  p_error_code text default null
)
returns void
language plpgsql
security definer
set search_path=''
volatile
as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true),'') <> 'service_role' then
    raise exception 'INTERNAL_ONLY';
  end if;

  insert into private.chat_ai_runs(
    request_id,conversation_id,tenant_id,user_id,question,question_hash,question_preview,decision,model,
    top_retrieval_score,retrieved_article_ids,handoff_id,latency_ms,error_code
  )
  values(
    p_request_id,
    p_conversation_id,
    p_tenant_id,
    p_user_id,
    left(coalesce(p_question_preview,''),160),
    left(coalesce(p_question_hash,''),128),
    left(coalesce(p_question_preview,''),600),
    p_decision,
    left(coalesce(p_model,''),120),
    p_top_retrieval_score,
    coalesce(p_retrieved_article_ids,'{}'),
    p_handoff_id,
    greatest(0,coalesce(p_latency_ms,0)),
    left(coalesce(p_error_code,''),120)
  )
  on conflict(request_id) do nothing;
end;
$$;

revoke all on function public.chat_ai_record_run(
  uuid,bigint,bigint,bigint,text,text,text,text,real,bigint[],bigint,integer,text
) from public,anon,authenticated;
grant execute on function public.chat_ai_record_run(
  uuid,bigint,bigint,bigint,text,text,text,text,real,bigint[],bigint,integer,text
) to service_role;
