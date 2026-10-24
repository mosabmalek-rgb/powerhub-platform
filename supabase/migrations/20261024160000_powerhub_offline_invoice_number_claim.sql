-- Bind server-issued invoice-number claims to the atomic platform reading + invoice path.
-- The deployed issuer keeps its tariff, tax, minimum-bill, fraction-settlement, carry-forward,
-- audit and notification logic. Only the sequence allocator is extended by a transaction-local claim.
do $patch_invoice_allocator$
declare
  v_definition text;
  v_declaration_anchor text := '  v_invoice_year integer;';
  v_allocator_block text := $old_allocator$
  v_invoice_year:=left(p_billing_period,4)::integer;
  insert into public.powerhub_invoice_sequences(invoice_year,next_sequence)
  values(v_invoice_year,2)
  on conflict (invoice_year) do update
    set next_sequence=public.powerhub_invoice_sequences.next_sequence+1
  returning next_sequence-1 into v_sequence;
  if not found or v_sequence is null or v_sequence < 1 then raise exception 'INVOICE_SEQUENCE_INVALID' using errcode='P0001'; end if;
  v_invoice_no:=format('INV-%s-%s',v_invoice_year,lpad(v_sequence::text,8,'0'));
$old_allocator$;
  v_replacement_block text := $new_allocator$
  v_invoice_year:=left(p_billing_period,4)::integer;
  v_offline_claim := nullif(current_setting('powerhub.offline_invoice_claim', true), '')::jsonb;
  if v_offline_claim is not null then
    if v_offline_claim->>'partitionKey' is distinct from v_invoice_year::text
       or coalesce(v_offline_claim->>'clientOperationId','') = '' then
      raise exception 'OFFLINE_NUMBER_IDEMPOTENCY_MISMATCH' using errcode='P0001';
    end if;
    if p_client_operation_id is not null
       and p_client_operation_id::text is distinct from v_offline_claim->>'clientOperationId' then
      raise exception 'OFFLINE_NUMBER_IDEMPOTENCY_MISMATCH' using errcode='P0001';
    end if;
    begin
      v_sequence := (v_offline_claim->>'numberValue')::bigint;
    exception when others then
      raise exception 'OFFLINE_NUMBER_VALUE_INVALID' using errcode='P0001';
    end;
    if v_sequence < 1 or v_sequence > 99999999 then
      raise exception 'OFFLINE_NUMBER_VALUE_INVALID' using errcode='P0001';
    end if;
    perform claimed.claim_id
    from public.powerhub_claim_offline_number(
      (v_offline_claim->>'grantId')::uuid, p_tenant_id, p_site_id, p_user_id,
      (v_offline_claim->>'deviceId')::uuid, 'invoice', v_invoice_year::text,
      v_sequence::text, v_offline_claim->>'clientOperationId', 'invoice'
    ) as claimed;
    if not found then raise exception 'OFFLINE_NUMBER_CLAIM_MISSING' using errcode='P0001'; end if;
  else
    insert into public.powerhub_invoice_sequences(invoice_year,next_sequence)
    values(v_invoice_year,2)
    on conflict (invoice_year) do update
      set next_sequence=public.powerhub_invoice_sequences.next_sequence+1
    returning next_sequence-1 into v_sequence;
    if not found or v_sequence is null or v_sequence < 1 then raise exception 'INVOICE_SEQUENCE_INVALID' using errcode='P0001'; end if;
  end if;
  v_invoice_no:=format('INV-%s-%s',v_invoice_year,lpad(v_sequence::text,8,'0'));
$new_allocator$;
begin
  v_definition := pg_get_functiondef(
    'public.powerhub_issue_invoice_from_reading(bigint,bigint,bigint,bigint,bigint,text,timestamp with time zone,numeric,uuid)'::regprocedure
  );
  if position(v_declaration_anchor in v_definition) = 0 then raise exception 'OFFLINE_INVOICE_ALLOCATOR_DECLARATION_ANCHOR_NOT_FOUND'; end if;
  if position('v_offline_claim jsonb;' in v_definition) > 0 then raise exception 'OFFLINE_INVOICE_ALLOCATOR_ALREADY_PATCHED'; end if;
  if position(v_allocator_block in v_definition) = 0 then raise exception 'OFFLINE_INVOICE_ALLOCATOR_BLOCK_NOT_FOUND'; end if;
  v_definition := replace(v_definition, v_declaration_anchor, v_declaration_anchor || E'\n  v_offline_claim jsonb;');
  v_definition := replace(v_definition, v_allocator_block, v_replacement_block);
  execute v_definition;
end
$patch_invoice_allocator$;

create or replace function public.powerhub_create_reading_and_issue_invoice_with_offline_number(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_subscriber_id bigint,
  p_client_operation_id uuid, p_reading_at timestamptz, p_reading_value numeric,
  p_capture_method text, p_image_key text, p_image_hash text, p_notes text,
  p_is_reading_reset boolean, p_field_verified boolean, p_can_override_same_day boolean,
  p_due_date timestamptz, p_billing_period text, p_offline_grant_id uuid,
  p_offline_device_id uuid, p_offline_number_value text, p_offline_partition_key text
)
returns table(
  reading_id bigint, consumption_kwh numeric, reading_status text, replayed boolean,
  invoice_id bigint, invoice_no text, total_amount numeric, notification_ids bigint[], already_processed boolean
)
language plpgsql
security definer
set search_path=public,pg_temp
as $offline_invoice_wrapper$
declare
  v_result record;
begin
  if p_client_operation_id is null or p_offline_grant_id is null or p_offline_device_id is null
     or p_offline_partition_key is null or p_offline_partition_key !~ '^[0-9]{4}$'
     or p_offline_partition_key is distinct from left(p_billing_period,4)
     or p_offline_number_value is null or p_offline_number_value !~ '^[1-9][0-9]{0,7}$' then
    raise exception 'OFFLINE_INVOICE_CLAIM_INPUT_INVALID' using errcode='P0001';
  end if;
  perform set_config(
    'powerhub.offline_invoice_claim',
    jsonb_build_object(
      'grantId',p_offline_grant_id,'deviceId',p_offline_device_id,
      'numberValue',p_offline_number_value,'partitionKey',p_offline_partition_key,
      'clientOperationId',p_client_operation_id::text
    )::text,
    true
  );
  select * into v_result
  from public.powerhub_create_reading_and_issue_invoice(
    p_tenant_id,p_site_id,p_user_id,p_subscriber_id,p_client_operation_id,
    p_reading_at,p_reading_value,p_capture_method,p_image_key,p_image_hash,p_notes,
    p_is_reading_reset,p_field_verified,p_can_override_same_day,p_due_date,p_billing_period
  );
  perform set_config('powerhub.offline_invoice_claim','',true);
  return query select v_result.reading_id,v_result.consumption_kwh,v_result.reading_status,
    v_result.replayed,v_result.invoice_id,v_result.invoice_no,v_result.total_amount,
    v_result.notification_ids,v_result.already_processed;
  return;
exception when others then
  perform set_config('powerhub.offline_invoice_claim','',true);
  raise;
end;
$offline_invoice_wrapper$;

revoke all on function public.powerhub_create_reading_and_issue_invoice_with_offline_number(
  bigint,bigint,bigint,bigint,uuid,timestamptz,numeric,text,text,text,text,boolean,boolean,boolean,timestamptz,text,uuid,uuid,text,text
) from public,anon,authenticated;
grant execute on function public.powerhub_create_reading_and_issue_invoice_with_offline_number(
  bigint,bigint,bigint,bigint,uuid,timestamptz,numeric,text,text,text,text,boolean,boolean,boolean,timestamptz,text,uuid,uuid,text,text
) to service_role;
alter function public.powerhub_create_reading_and_issue_invoice_with_offline_number(
  bigint,bigint,bigint,bigint,uuid,timestamptz,numeric,text,text,text,text,boolean,boolean,boolean,timestamptz,text,uuid,uuid,text,text
) owner to postgres;
