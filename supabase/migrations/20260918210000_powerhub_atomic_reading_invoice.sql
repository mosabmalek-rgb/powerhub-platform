create or replace function public.powerhub_create_and_issue_reading(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_subscriber_id bigint,
  p_client_operation_id uuid,
  p_reading_at timestamptz,
  p_reading_value numeric,
  p_capture_method text,
  p_image_key text,
  p_image_hash text,
  p_notes text,
  p_is_reading_reset boolean,
  p_field_verified boolean,
  p_can_override_same_day boolean,
  p_due_date timestamptz,
  p_billing_period text,
  p_discount_amount numeric default 0
)
returns table(
  reading_id bigint,
  consumption_kwh numeric,
  invoice_id bigint,
  invoice_no text,
  total_amount numeric,
  notification_ids bigint[],
  replayed boolean,
  already_processed boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_created record;
  v_result record;
begin
  select *
    into v_created
  from public.powerhub_create_reading(
    p_tenant_id,
    p_site_id,
    p_user_id,
    p_subscriber_id,
    p_client_operation_id,
    p_reading_at,
    p_reading_value,
    p_capture_method,
    p_image_key,
    p_image_hash,
    p_notes,
    p_is_reading_reset,
    p_field_verified,
    p_can_override_same_day
  );

  select *
    into v_result
  from public.powerhub_approve_and_issue_mobile_reading(
    p_tenant_id,
    p_site_id,
    p_user_id,
    v_created.reading_id,
    1,
    p_due_date,
    p_billing_period,
    p_discount_amount
  );

  return query
  select
    v_created.reading_id,
    v_created.consumption_kwh,
    v_result.invoice_id,
    v_result.invoice_no,
    v_result.total_amount,
    v_result.notification_ids,
    v_created.replayed,
    v_result.already_processed;
end;
$function$;

revoke all on function public.powerhub_create_and_issue_reading(
  bigint,bigint,bigint,bigint,uuid,timestamptz,numeric,text,text,text,text,boolean,boolean,boolean,timestamptz,text,numeric
) from public, anon, authenticated;

grant execute on function public.powerhub_create_and_issue_reading(
  bigint,bigint,bigint,bigint,uuid,timestamptz,numeric,text,text,text,text,boolean,boolean,boolean,timestamptz,text,numeric
) to service_role;
