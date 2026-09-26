-- PowerHub P0: bigint invoice allocator and one sequence-backed issuance contract.
-- This migration is additive and removes the historical annual 9,999 ceiling.

alter table public.powerhub_invoice_sequences
  alter column next_sequence type bigint using next_sequence::bigint;
alter table public.powerhub_invoice_sequences
  drop constraint if exists powerhub_invoice_sequences_next_sequence_check;
alter table public.powerhub_invoice_sequences
  add constraint powerhub_invoice_sequences_next_sequence_check check (next_sequence > 0);


  create or replace function public.powerhub_issue_invoice_from_reading(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_reading_id bigint,
  p_tariff_id bigint,
  p_billing_period text,
  p_due_date timestamptz,
  p_discount_amount numeric,
  p_client_operation_id uuid
)
returns table(invoice_id bigint,invoice_no text,total_amount numeric,replayed boolean)
language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  v_reading public.meter_readings%rowtype;
  v_subscriber public.subscribers%rowtype;
  v_site public.sites%rowtype;
  v_tariff public.tariffs%rowtype;
  v_existing public.invoices%rowtype;
  v_response jsonb;
  v_invoice_id bigint;
  v_invoice_no text;
  v_energy_amount numeric(14,2);
  v_tax_amount numeric(14,2);
  v_total_amount numeric(14,2);
  v_platform_role text;
  v_sequence bigint;
  v_invoice_year integer;
begin
  if p_billing_period !~ '^[0-9]{4}-[0-9]{2}$' then raise exception 'INVALID_BILLING_PERIOD' using errcode='P0001'; end if;
  if p_discount_amount<0 then raise exception 'INVALID_DISCOUNT' using errcode='P0001'; end if;
  if p_client_operation_id is not null then
    select response into v_response from public.offline_sync_operations where user_id=p_user_id and client_operation_id=p_client_operation_id::text limit 1;
    if found then
      if coalesce(v_response->>'id','')='' or coalesce(v_response->>'invoiceNo','')='' then raise exception 'INVALID_INVOICE_OPERATION_REPLAY' using errcode='P0001'; end if;
      return query select (v_response->>'id')::bigint,v_response->>'invoiceNo',(v_response->>'totalAmount')::numeric,true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(p_reading_id);
  select r.* into v_reading from public.meter_readings r where r.id=p_reading_id and r.tenant_id=p_tenant_id for update;
  if not found then raise exception 'READING_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select * into v_subscriber from public.subscribers where id=v_reading.subscriber_id and tenant_id=p_tenant_id and site_id=p_site_id;
  if not found then raise exception 'READING_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select * into v_site from public.sites where id=p_site_id and tenant_id=p_tenant_id;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if v_reading.status<>'approved' then raise exception 'READING_NOT_APPROVED' using errcode='P0001'; end if;
  select * into v_existing from public.invoices where reading_id=p_reading_id limit 1;
  if found then return query select v_existing.id,v_existing.invoice_no,v_existing.total_amount,true; return; end if;
  if exists(select 1 from public.financial_settlements where tenant_id=p_tenant_id and site_id=p_site_id and status='locked' and period_start<=p_due_date and period_end>=p_due_date) then raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001'; end if;
  select * into v_tariff from public.tariffs where id=p_tariff_id and tenant_id=p_tenant_id and site_id=p_site_id and is_active=true;
  if not found then raise exception 'TARIFF_NOT_FOUND' using errcode='P0001'; end if;

  -- Allocate from a persistent per-year sequence. The row-level upsert serializes
  -- concurrent issuances and, unlike COUNT(invoices), never reuses a deleted number.
  v_invoice_year:=left(p_billing_period,4)::integer;
  insert into public.powerhub_invoice_sequences(invoice_year,next_sequence)
  values(v_invoice_year,2)
  on conflict (invoice_year) do update
    set next_sequence=public.powerhub_invoice_sequences.next_sequence+1
  returning next_sequence-1 into v_sequence;
  if not found or v_sequence is null or v_sequence < 1 then raise exception 'INVOICE_SEQUENCE_INVALID' using errcode='P0001'; end if;
  v_invoice_no:=format('INV-%s-%s',v_invoice_year,lpad(v_sequence::text,8,'0'));

  v_energy_amount:=round(coalesce(v_reading.consumption_kwh,0)*v_tariff.price_per_kwh,2);
  v_tax_amount:=round((v_energy_amount+v_tariff.fixed_fee)*(v_tariff.tax_rate/100),2);
  v_total_amount:=greatest(0,round(v_energy_amount+v_tariff.fixed_fee+v_tax_amount-p_discount_amount,2));
  insert into public.invoices(tenant_id,site_id,subscriber_id,reading_id,tariff_id,invoice_no,client_operation_id,billing_period,due_date,previous_reading,current_reading,consumption_kwh,price_per_kwh,fixed_fee,tax_amount,discount_amount,total_amount,balance_due,status,created_by_user_id)
  values(p_tenant_id,p_site_id,v_subscriber.id,p_reading_id,v_tariff.id,v_invoice_no,p_client_operation_id::text,p_billing_period,p_due_date,v_reading.previous_reading_value,v_reading.reading_value,coalesce(v_reading.consumption_kwh,0),v_tariff.price_per_kwh,v_tariff.fixed_fee,v_tax_amount,p_discount_amount,v_total_amount,v_total_amount,'issued',p_user_id)
  returning id into v_invoice_id;

  insert into public.invoice_lines(tenant_id,invoice_id,line_type,description,quantity,unit_price,amount,display_order)
  values(p_tenant_id,v_invoice_id,'energy','استهلاك الكهرباء',coalesce(v_reading.consumption_kwh,0),v_tariff.price_per_kwh,v_energy_amount,1),(p_tenant_id,v_invoice_id,'fixed_fee','رسم ثابت',1,v_tariff.fixed_fee,v_tariff.fixed_fee,2),(p_tenant_id,v_invoice_id,'tax','الضريبة',1,v_tariff.tax_rate,v_tax_amount,3);
  if p_discount_amount>0 then insert into public.invoice_lines(tenant_id,invoice_id,line_type,description,quantity,unit_price,amount,display_order) values(p_tenant_id,v_invoice_id,'discount','خصم',1,p_discount_amount,p_discount_amount,4); end if;
  select platform_role into v_platform_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
  values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'invoice',v_invoice_id::text,'issue',jsonb_build_object('readingId',p_reading_id,'tariffId',p_tariff_id,'invoiceNo',v_invoice_no,'billingPeriod',p_billing_period,'totalAmount',v_total_amount,'deliveryQueued',false));
  if p_client_operation_id is not null then
    insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response)
    values(p_tenant_id,p_site_id,p_user_id,p_client_operation_id::text,'invoice_issue','invoice',v_invoice_id,jsonb_build_object('id',v_invoice_id,'invoiceNo',v_invoice_no,'totalAmount',v_total_amount));
  end if;
  return query select v_invoice_id,v_invoice_no,v_total_amount,false;
end;$$;

revoke execute on function public.powerhub_issue_invoice_from_reading(bigint,bigint,bigint,bigint,bigint,text,timestamptz,numeric,uuid) from public,anon,authenticated;
grant execute on function public.powerhub_issue_invoice_from_reading(bigint,bigint,bigint,bigint,bigint,text,timestamptz,numeric,uuid) to service_role;


-- The mobile approval path uses the same allocator; no COUNT(*) or advisory site-period lock.
create or replace function public.powerhub_approve_and_issue_mobile_reading(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_reading_id bigint,
  p_base_version integer,
  p_due_date timestamptz,
  p_billing_period text,
  p_discount_amount numeric default 0
)
returns table(invoice_id bigint, invoice_no text, total_amount numeric, notification_ids bigint[], already_processed boolean)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_reading public.meter_readings%rowtype;
  v_subscriber public.subscribers%rowtype;
  v_site public.sites%rowtype;
  v_existing public.invoices%rowtype;
  v_tariff public.tariffs%rowtype;
  v_platform_role text;
  v_version integer;
  v_sequence bigint;
  v_invoice_id bigint;
  v_notification_id bigint;
  v_invoice_no text;
  v_energy_amount numeric(14,2);
  v_tax_amount numeric(14,2);
  v_total_amount numeric(14,2);
  v_notification_ids bigint[] := array[]::bigint[];
  v_channel text;
  v_template text;
  v_recipient text;
  v_rendered text;
  v_policy jsonb := '{}'::jsonb;
  v_whatsapp_enabled boolean := true;
  v_sms_enabled boolean := true;
  v_policy_enabled boolean := true;
  v_has_channel boolean := false;
begin
  if p_billing_period !~ '^[0-9]{4}-[0-9]{2}$' then raise exception 'INVALID_BILLING_PERIOD' using errcode='P0001'; end if;
  if p_discount_amount < 0 then raise exception 'INVALID_DISCOUNT' using errcode='P0001'; end if;

  perform pg_advisory_xact_lock(p_reading_id);
  select r.* into v_reading from public.meter_readings r where r.id=p_reading_id and r.tenant_id=p_tenant_id for update;
  if not found then raise exception 'READING_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select s.* into v_subscriber from public.subscribers s where s.id=v_reading.subscriber_id and s.tenant_id=p_tenant_id and s.site_id=p_site_id;
  if not found then raise exception 'READING_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select s.* into v_site from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select i.* into v_existing from public.invoices i where i.reading_id=p_reading_id limit 1;
  if found and v_reading.status='approved' then
    return query select v_existing.id,v_existing.invoice_no,v_existing.total_amount,array[]::bigint[],true;
    return;
  end if;
  if v_reading.status <> 'pending_review' then raise exception 'READING_NOT_PENDING' using errcode='P0001'; end if;
  if v_reading.version_no <> p_base_version then raise exception 'READING_VERSION_CONFLICT' using errcode='P0001'; end if;

  update public.meter_readings set status='approved',reviewed_by_user_id=p_user_id,reviewed_at=now(),version_no=version_no+1
  where id=p_reading_id and status='pending_review' and version_no=p_base_version returning version_no into v_version;
  if v_version is null then raise exception 'READING_VERSION_CONFLICT' using errcode='P0001'; end if;

  if exists(select 1 from public.financial_settlements where tenant_id=p_tenant_id and site_id=p_site_id and status='locked' and period_start<=p_due_date and period_end>=p_due_date) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;

  select t.* into v_tariff from public.tariffs t where t.tenant_id=p_tenant_id and t.site_id=p_site_id and t.is_active=true order by t.effective_from desc limit 1;
  if not found then raise exception 'TARIFF_NOT_FOUND' using errcode='P0001'; end if;

  insert into public.powerhub_invoice_sequences(invoice_year,next_sequence)
  values(left(p_billing_period,4)::integer,2)
  on conflict (invoice_year) do update
    set next_sequence=public.powerhub_invoice_sequences.next_sequence+1
  returning next_sequence-1 into v_sequence;
  if not found or v_sequence is null or v_sequence < 1 then raise exception 'INVOICE_SEQUENCE_INVALID' using errcode='P0001'; end if;
  v_invoice_no:=format('INV-%s-%s',left(p_billing_period,4),lpad(v_sequence::text,8,'0'));
  v_energy_amount:=round(coalesce(v_reading.consumption_kwh,0)*v_tariff.price_per_kwh,2);
  v_tax_amount:=round((v_energy_amount+v_tariff.fixed_fee)*(v_tariff.tax_rate/100),2);
  v_total_amount:=greatest(0,round(v_energy_amount+v_tariff.fixed_fee+v_tax_amount-p_discount_amount,2));

  insert into public.invoices(tenant_id,site_id,subscriber_id,reading_id,tariff_id,invoice_no,billing_period,due_date,previous_reading,current_reading,consumption_kwh,price_per_kwh,fixed_fee,tax_amount,discount_amount,total_amount,balance_due,status,created_by_user_id)
  values(p_tenant_id,p_site_id,v_subscriber.id,p_reading_id,v_tariff.id,v_invoice_no,p_billing_period,p_due_date,v_reading.previous_reading_value,v_reading.reading_value,coalesce(v_reading.consumption_kwh,0),v_tariff.price_per_kwh,v_tariff.fixed_fee,v_tax_amount,p_discount_amount,v_total_amount,v_total_amount,'issued',p_user_id)
  returning id into v_invoice_id;

  insert into public.invoice_lines(tenant_id,invoice_id,line_type,description,quantity,unit_price,amount,display_order) values
    (p_tenant_id,v_invoice_id,'energy','استهلاك الكهرباء',coalesce(v_reading.consumption_kwh,0),v_tariff.price_per_kwh,v_energy_amount,1),
    (p_tenant_id,v_invoice_id,'fixed_fee','رسم ثابت',1,v_tariff.fixed_fee,v_tariff.fixed_fee,2),
    (p_tenant_id,v_invoice_id,'tax','الضريبة',1,v_tariff.tax_rate,v_tax_amount,3);
  if p_discount_amount>0 then insert into public.invoice_lines(tenant_id,invoice_id,line_type,description,quantity,unit_price,amount,display_order) values(p_tenant_id,v_invoice_id,'discount','خصم',1,p_discount_amount,p_discount_amount,4); end if;

  select platform_role into v_platform_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
  values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'meter_reading',p_reading_id::text,'approve',jsonb_build_object('status','approved','versionNo',v_version));
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
  values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'invoice',v_invoice_id::text,'issue',jsonb_build_object('readingId',p_reading_id,'tariffId',v_tariff.id,'invoiceNo',v_invoice_no,'billingPeriod',p_billing_period,'totalAmount',v_total_amount,'automaticInvoice',true));

  select coalesce(ps.value,'{}'::jsonb),coalesce(ps.is_enabled,true) into v_policy,v_policy_enabled from public.platform_settings ps where ps.setting_key='invoice_delivery_channels' limit 1;
  v_whatsapp_enabled:=coalesce((v_policy->>'whatsappEnabled')::boolean,true);
  v_sms_enabled:=coalesce((v_policy->>'smsEnabled')::boolean,true);

  for v_channel in select distinct c.channel from public.tenant_messaging_configurations c
    where c.tenant_id=p_tenant_id and c.is_active=true and v_policy_enabled
      and ((c.channel='whatsapp' and v_whatsapp_enabled) or (c.channel='sms' and v_sms_enabled)) loop
    v_has_channel:=true;
    v_recipient:=case when v_channel='whatsapp' then coalesce(v_subscriber.whatsapp_number,v_subscriber.phone) else v_subscriber.phone end;
    select t.body into v_template from public.tenant_invoice_message_templates t
      where t.tenant_id=p_tenant_id and t.channel=v_channel and t.event_type='invoice_issued' and t.is_active=true order by t.updated_at desc limit 1;
    if v_template is null then
      v_template:=case when v_channel='whatsapp' then 'مرحباً {{subscriber_name}}، صدرت فاتورتك رقم {{invoice_no}} عن فترة {{billing_period}} بإجمالي {{total_amount}}. تاريخ الاستحقاق: {{due_date}}.' else 'PowerHub: {{subscriber_name}}، فاتورتك {{invoice_no}} للفترة {{billing_period}} بقيمة {{total_amount}}. الاستحقاق: {{due_date}}.' end;
    end if;
    v_rendered:=replace(replace(replace(replace(replace(v_template,'{{subscriber_name}}',coalesce(v_subscriber.full_name,'')),'{{invoice_no}}',v_invoice_no),'{{billing_period}}',p_billing_period),'{{total_amount}}',v_total_amount::text),'{{due_date}}',to_char(p_due_date at time zone 'Asia/Gaza','DD/MM/YYYY'));
    insert into public.notification_messages(tenant_id,invoice_id,subscriber_id,channel,event_type,recipient,status,payload)
      values(p_tenant_id,v_invoice_id,v_subscriber.id,v_channel,'invoice_issued',v_recipient,'pending',jsonb_build_object('invoiceNo',v_invoice_no,'billingPeriod',p_billing_period,'totalAmount',v_total_amount,'renderedText',v_rendered)) returning id into v_notification_id;
    v_notification_ids:=array_append(v_notification_ids,v_notification_id);
  end loop;

  if not v_has_channel and v_policy_enabled and v_whatsapp_enabled then
    v_rendered:=format('مرحباً %s، صدرت فاتورتك رقم %s عن فترة %s بإجمالي %s. تاريخ الاستحقاق: %s.',coalesce(v_subscriber.full_name,''),v_invoice_no,p_billing_period,v_total_amount,to_char(p_due_date at time zone 'Asia/Gaza','DD/MM/YYYY'));
    insert into public.notification_messages(tenant_id,invoice_id,subscriber_id,channel,event_type,recipient,status,payload)
      values(p_tenant_id,v_invoice_id,v_subscriber.id,'whatsapp','invoice_issued',coalesce(v_subscriber.whatsapp_number,v_subscriber.phone),'pending',jsonb_build_object('invoiceNo',v_invoice_no,'billingPeriod',p_billing_period,'totalAmount',v_total_amount,'renderedText',v_rendered)) returning id into v_notification_id;
    v_notification_ids:=array_append(v_notification_ids,v_notification_id);
  end if;

  return query select v_invoice_id,v_invoice_no,v_total_amount,v_notification_ids,false;
end;$$;

revoke execute on function public.powerhub_approve_and_issue_mobile_reading(bigint,bigint,bigint,bigint,integer,timestamptz,text,numeric) from public,anon,authenticated;
grant execute on function public.powerhub_approve_and_issue_mobile_reading(bigint,bigint,bigint,bigint,integer,timestamptz,text,numeric) to service_role;
