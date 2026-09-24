-- Temporary compatibility overload for the pre-merge production worker.
-- The legacy seventh parameter is intentionally ignored. Delivery uncertainty is
-- no longer represented as a business state; unsuccessful confirmation remains failed.

create or replace function public.powerhub_finish_sms_notification(
  p_user_id bigint,
  p_notification_id bigint,
  p_attempt_number integer,
  p_success boolean,
  p_provider_message_id text,
  p_error text,
  p_delivery_uncertain boolean
)
returns table(notification_id bigint,status text,provider_message_id text,segment_count integer)
language plpgsql security invoker
set search_path = public, pg_temp
as $function$
begin
  return query
  select *
  from public.powerhub_finish_sms_notification(
    p_user_id,
    p_notification_id,
    p_attempt_number,
    p_success,
    p_provider_message_id,
    case
      when p_success then p_error
      when p_delivery_uncertain then coalesce(p_error, 'لم يثبت نجاح الإرسال؛ اعتُبرت الرسالة غير مرسلة.')
      else p_error
    end
  );
end;
$function$;

revoke all on function public.powerhub_finish_sms_notification(bigint,bigint,integer,boolean,text,text,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_finish_sms_notification(bigint,bigint,integer,boolean,text,text,boolean) to service_role;
