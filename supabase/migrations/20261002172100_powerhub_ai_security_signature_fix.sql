-- Fix the exact signature used by chat_ai_record_run.
revoke all on function public.chat_ai_record_run(
  uuid,bigint,bigint,bigint,text,text,text,text,real,bigint[],bigint,integer,text
) from public,anon,authenticated;

grant execute on function public.chat_ai_record_run(
  uuid,bigint,bigint,bigint,text,text,text,text,real,bigint[],bigint,integer,text
) to service_role;
