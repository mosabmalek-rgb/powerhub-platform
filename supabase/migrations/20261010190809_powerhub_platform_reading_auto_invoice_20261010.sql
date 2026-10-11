-- Atomic server-owned path: create a platform reading, approve it, and issue its invoice in one PostgreSQL transaction.
-- Existing subscriber RPCs are deliberately not redefined here; a later compatibility migration
-- preserves the deployed production definitions while enabling automatic opening-baseline approval.

create or replace function public.powerhub_create_reading_and_issue_invoice(
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
  p_billing_period text
)
returns table(
  reading_id bigint,
  consumption_kwh numeric,
  reading_status text,
  replayed boolean,
  invoice_id bigint,
  invoice_no text,
  total_amount numeric,
  notification_ids bigint[],
  already_processed boolean
)
language plpgsql
security definer
set search_path=public,pg_temp
as $function$
declare
  v_created record;
  v_reading public.meter_readings%rowtype;
  v_existing_invoice public.invoices%rowtype;
  v_issued record;
  v_tariff_id bigint;
begin
  if p_due_date is null then
    raise exception 'INVALID_DUE_DATE' using errcode='P0001';
  end if;
  if p_billing_period !~ '^[0-9]{4}-[0-9]{2}$' then
    raise exception 'INVALID_BILLING_PERIOD' using errcode='P0001';
  end if;

  -- Both operations execute in this transaction. If approval or invoice issuance fails,
  -- the just-created reading is rolled back instead of being left in a hidden review queue.
  select * into v_created
  from public.powerhub_create_reading(
    p_tenant_id,p_site_id,p_user_id,p_subscriber_id,p_client_operation_id,
    p_reading_at,p_reading_value,p_capture_method,p_image_key,p_image_hash,p_notes,
    p_is_reading_reset,p_field_verified,p_can_override_same_day
  );

  select mr.* into v_reading
  from public.meter_readings mr
  where mr.id=v_created.reading_id and mr.tenant_id=p_tenant_id
  for update;
  if not found then
    raise exception 'READING_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if coalesce(v_reading.is_opening_baseline,false) then
    raise exception 'OPENING_BASELINE_NOT_BILLABLE' using errcode='P0001';
  end if;

  -- Idempotent replay: reuse an existing invoice and never bill a reading twice.
  if v_reading.status='approved' then
    select i.* into v_existing_invoice
    from public.invoices i
    where i.tenant_id=p_tenant_id and i.reading_id=v_reading.id
    limit 1;

    if found then
      return query select
        v_reading.id,coalesce(v_reading.consumption_kwh,0),v_reading.status,
        true,v_existing_invoice.id,v_existing_invoice.invoice_no,v_existing_invoice.total_amount,
        array[]::bigint[],true;
      return;
    end if;

    -- Recover older approved readings that were approved before automatic invoicing was enabled.
    select t.id into v_tariff_id
    from public.tariffs t
    where t.tenant_id=p_tenant_id and t.site_id=p_site_id and t.is_active=true
    order by t.effective_from desc limit 1;
    if v_tariff_id is null then
      raise exception 'TARIFF_NOT_FOUND' using errcode='P0001';
    end if;

    select * into v_issued
    from public.powerhub_issue_invoice_from_reading(
      p_tenant_id,p_site_id,p_user_id,v_reading.id,v_tariff_id,
      p_billing_period,p_due_date,0,p_client_operation_id
    );

    return query select
      v_reading.id,coalesce(v_reading.consumption_kwh,0),v_reading.status,
      coalesce(v_created.replayed,false),v_issued.invoice_id,v_issued.invoice_no,v_issued.total_amount,
      array[]::bigint[],coalesce(v_issued.replayed,false);
    return;
  end if;

  if v_reading.status <> 'pending_review' then
    raise exception 'READING_NOT_PENDING' using errcode='P0001';
  end if;

  select * into v_issued
  from public.powerhub_approve_and_issue_mobile_reading(
    p_tenant_id,p_site_id,p_user_id,v_reading.id,v_reading.version_no,
    p_due_date,p_billing_period,0
  );

  return query select
    v_reading.id,coalesce(v_reading.consumption_kwh,0),'approved'::text,
    coalesce(v_created.replayed,false),v_issued.invoice_id,v_issued.invoice_no,v_issued.total_amount,
    coalesce(v_issued.notification_ids,array[]::bigint[]),coalesce(v_issued.already_processed,false);
end;
$function$;

revoke execute on function public.powerhub_create_reading_and_issue_invoice(bigint,bigint,bigint,bigint,uuid,timestamptz,numeric,text,text,text,text,boolean,boolean,boolean,timestamptz,text) from public,anon,authenticated;
grant execute on function public.powerhub_create_reading_and_issue_invoice(bigint,bigint,bigint,bigint,uuid,timestamptz,numeric,text,text,text,text,boolean,boolean,boolean,timestamptz,text) to service_role;
