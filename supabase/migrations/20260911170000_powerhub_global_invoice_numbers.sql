-- Global invoice numbering.
-- Format: INV-YYYY-NNNN (for example INV-2026-0001).
-- The sequence is global across all tenants/sites within the invoice year.
-- The existing unique constraint on public.invoices.invoice_no remains the final database guard.

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
  v_sequence integer;
  v_invoice_year text;
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

  -- Serialize invoice allocation globally for the year, not per site.
  v_invoice_year:=left(p_billing_period,4);
  perform pg_advisory_xact_lock(hashtext('powerhub-global-invoice:'||v_invoice_year));
  select count(*)::integer+1 into v_sequence
    from public.invoices
   where invoice_no like 'INV-'||v_invoice_year||'-%';
  if v_sequence>9999 then raise exception 'INVOICE_SEQUENCE_EXHAUSTED' using errcode='P0001'; end if;
  v_invoice_no:=format('INV-%s-%s',v_invoice_year,lpad(v_sequence::text,4,'0'));

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
