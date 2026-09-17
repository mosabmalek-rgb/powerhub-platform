-- Reconcile Production runtime contracts discovered during the 2026-09-17 audit.
-- This migration records the live repair work without modifying application data.

create table if not exists public.powerhub_invoice_sequences (
  invoice_year integer primary key,
  next_sequence integer not null check (next_sequence between 1 and 10000)
);
alter table public.powerhub_invoice_sequences enable row level security;
revoke all on table public.powerhub_invoice_sequences from public, anon, authenticated;
grant select, insert, update on table public.powerhub_invoice_sequences to service_role;

insert into public.powerhub_invoice_sequences(invoice_year,next_sequence)
select years.invoice_year, greatest(max(years.sequence_no)+1,1)
from (
  select (regexp_match(invoice_no,'^INV-([0-9]{4})-([0-9]{4})$'))[1]::integer invoice_year,
         (regexp_match(invoice_no,'^INV-([0-9]{4})-([0-9]{4})$'))[2]::integer sequence_no
  from public.invoices where invoice_no ~ '^INV-[0-9]{4}-[0-9]{4}$'
) years
where years.invoice_year is not null and years.sequence_no is not null
group by years.invoice_year
on conflict (invoice_year) do update set next_sequence=greatest(public.powerhub_invoice_sequences.next_sequence,excluded.next_sequence);

create or replace function public.powerhub_issue_invoice_from_reading(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_reading_id bigint,p_tariff_id bigint,
  p_billing_period text,p_due_date timestamptz,p_discount_amount numeric,p_client_operation_id uuid
)
returns table(invoice_id bigint,invoice_no text,total_amount numeric,replayed boolean)
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_reading public.meter_readings%rowtype; v_subscriber public.subscribers%rowtype; v_site public.sites%rowtype; v_tariff public.tariffs%rowtype; v_existing public.invoices%rowtype; v_response jsonb; v_invoice_id bigint; v_invoice_no text; v_energy_amount numeric(14,2); v_tax_amount numeric(14,2); v_total_amount numeric(14,2); v_platform_role text; v_sequence integer; v_invoice_year integer;
begin
 if p_billing_period !~ '^[0-9]{4}-[0-9]{2}$' then raise exception 'INVALID_BILLING_PERIOD' using errcode='P0001'; end if;
 if p_discount_amount<0 then raise exception 'INVALID_DISCOUNT' using errcode='P0001'; end if;
 if p_client_operation_id is not null then
   select response into v_response from public.offline_sync_operations where user_id=p_user_id and client_operation_id=p_client_operation_id::text limit 1;
   if found then if coalesce(v_response->>'id','')='' or coalesce(v_response->>'invoiceNo','')='' then raise exception 'INVALID_INVOICE_OPERATION_REPLAY' using errcode='P0001'; end if; return query select (v_response->>'id')::bigint,v_response->>'invoiceNo',(v_response->>'totalAmount')::numeric,true; return; end if;
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
 v_invoice_year:=left(p_billing_period,4)::integer;
 insert into public.powerhub_invoice_sequences(invoice_year,next_sequence) values(v_invoice_year,2)
 on conflict (invoice_year) do update set next_sequence=public.powerhub_invoice_sequences.next_sequence+1 where public.powerhub_invoice_sequences.next_sequence<=9999
 returning next_sequence-1 into v_sequence;
 if not found or v_sequence is null or v_sequence>9999 then raise exception 'INVOICE_SEQUENCE_EXHAUSTED' using errcode='P0001'; end if;
 v_invoice_no:=format('INV-%s-%s',v_invoice_year,lpad(v_sequence::text,4,'0'));
 v_energy_amount:=round(coalesce(v_reading.consumption_kwh,0)*v_tariff.price_per_kwh,2);
 v_tax_amount:=round((v_energy_amount+v_tariff.fixed_fee)*(v_tariff.tax_rate/100),2);
 v_total_amount:=greatest(0,round(v_energy_amount+v_tariff.fixed_fee+v_tax_amount-p_discount_amount,2));
 insert into public.invoices(tenant_id,site_id,subscriber_id,reading_id,tariff_id,invoice_no,client_operation_id,billing_period,due_date,previous_reading,current_reading,consumption_kwh,price_per_kwh,fixed_fee,tax_amount,discount_amount,total_amount,balance_due,status,created_by_user_id)
 values(p_tenant_id,p_site_id,v_subscriber.id,p_reading_id,v_tariff.id,v_invoice_no,p_client_operation_id::text,p_billing_period,p_due_date,v_reading.previous_reading_value,v_reading.reading_value,coalesce(v_reading.consumption_kwh,0),v_tariff.price_per_kwh,v_tariff.fixed_fee,v_tax_amount,p_discount_amount,v_total_amount,v_total_amount,'issued',p_user_id) returning id into v_invoice_id;
 insert into public.invoice_lines(tenant_id,invoice_id,line_type,description,quantity,unit_price,amount,display_order)
 values(p_tenant_id,v_invoice_id,'energy','استهلاك الكهرباء',coalesce(v_reading.consumption_kwh,0),v_tariff.price_per_kwh,v_energy_amount,1),(p_tenant_id,v_invoice_id,'fixed_fee','رسم ثابت',1,v_tariff.fixed_fee,v_tariff.fixed_fee,2),(p_tenant_id,v_invoice_id,'tax','الضريبة',1,v_tariff.tax_rate,v_tax_amount,3);
 if p_discount_amount>0 then insert into public.invoice_lines(tenant_id,invoice_id,line_type,description,quantity,unit_price,amount,display_order) values(p_tenant_id,v_invoice_id,'discount','خصم',1,p_discount_amount,p_discount_amount,4); end if;
 select platform_role into v_platform_role from public.users where id=p_user_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'invoice',v_invoice_id::text,'issue',jsonb_build_object('readingId',p_reading_id,'tariffId',p_tariff_id,'invoiceNo',v_invoice_no,'billingPeriod',p_billing_period,'totalAmount',v_total_amount,'deliveryQueued',false));
 if p_client_operation_id is not null then insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response) values(p_tenant_id,p_site_id,p_user_id,p_client_operation_id::text,'invoice_issue','invoice',v_invoice_id,jsonb_build_object('id',v_invoice_id,'invoiceNo',v_invoice_no,'totalAmount',v_total_amount)); end if;
 return query select v_invoice_id,v_invoice_no,v_total_amount,false;
end;$$;
revoke execute on function public.powerhub_issue_invoice_from_reading(bigint,bigint,bigint,bigint,bigint,text,timestamptz,numeric,uuid) from public,anon,authenticated;
grant execute on function public.powerhub_issue_invoice_from_reading(bigint,bigint,bigint,bigint,bigint,text,timestamptz,numeric,uuid) to service_role;

alter table public.generators add column if not exists client_operation_id text;
create unique index if not exists generators_client_operation_id_key on public.generators(client_operation_id) where client_operation_id is not null;

create or replace function public.powerhub_sync_generator_create(p_site_id bigint,p_code text,p_name text,p_serial_number text,p_rated_capacity_kw numeric,p_fuel_type text,p_client_operation_id text)
returns table(id bigint,name text,replayed boolean) language plpgsql security invoker as $$
declare v_user_id bigint; v_tenant_id bigint; v_role text; v_allowed boolean; v_generator public.generators%rowtype; v_operation public.offline_sync_operations%rowtype;
begin
 select u.id into v_user_id from public.users u where u.auth_user_id=auth.uid() and u.account_status='active' limit 1; if v_user_id is null then raise exception 'AUTH_USER_NOT_FOUND'; end if;
 select s.tenant_id into v_tenant_id from public.sites s where s.id=p_site_id and s.status<>'archived'; if v_tenant_id is null then raise exception 'SITE_OUT_OF_SCOPE'; end if;
 select case when u.role='admin' then 'owner' else null end into v_role from public.users u where u.id=v_user_id;
 if v_role is null then select 'owner' into v_role from public.tenant_members m where m.tenant_id=v_tenant_id and m.user_id=v_user_id and m.role='owner' and m.is_active and m.membership_status='active' limit 1; end if;
 if v_role is null then select p.role into v_role from public.staff_profiles p where p.tenant_id=v_tenant_id and p.user_id=v_user_id and p.is_active and (p.site_id is null or p.site_id=p_site_id) and ((p.permissions @> '["manageGenerators"]'::jsonb) or p.role in ('owner','manager','technician')) limit 1; end if;
 if v_role is null then raise exception 'GENERATOR_MANAGEMENT_FORBIDDEN'; end if;
 if v_role<>'owner' then select pr.is_allowed into v_allowed from public.platform_role_policies pr where pr.role=v_role and pr.capability='manageGenerators' limit 1; if v_allowed is false then raise exception 'GENERATOR_MANAGEMENT_FORBIDDEN'; end if; end if;
 if p_client_operation_id is null then raise exception 'CLIENT_OPERATION_REQUIRED'; end if;
 select * into v_operation from public.offline_sync_operations o where o.user_id=v_user_id and o.client_operation_id=p_client_operation_id limit 1;
 if found then if v_operation.operation_type<>'generator_create' then raise exception 'GENERATOR_OPERATION_TYPE_CONFLICT'; end if; return query select (v_operation.response->>'id')::bigint,coalesce(v_operation.response->>'name',''),true; return; end if;
 insert into public.generators(tenant_id,site_id,code,name,serial_number,rated_capacity_kw,fuel_type,client_operation_id) values(v_tenant_id,p_site_id,upper(trim(p_code)),trim(p_name),nullif(trim(coalesce(p_serial_number,'')),''),p_rated_capacity_kw,p_fuel_type,p_client_operation_id) returning * into v_generator;
 insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response) values(v_tenant_id,p_site_id,v_user_id,p_client_operation_id,'generator_create','generator',v_generator.id,jsonb_build_object('id',v_generator.id,'name',v_generator.name));
 return query select v_generator.id,v_generator.name,false;
exception when unique_violation then select * into v_operation from public.offline_sync_operations o where o.user_id=v_user_id and o.client_operation_id=p_client_operation_id limit 1; if found and v_operation.operation_type='generator_create' then return query select (v_operation.response->>'id')::bigint,coalesce(v_operation.response->>'name',''),true; return; end if; select * into v_generator from public.generators g where g.client_operation_id=p_client_operation_id and g.tenant_id=v_tenant_id and g.site_id=p_site_id limit 1; if found then return query select v_generator.id,v_generator.name,true; return; end if; raise;
end;$$;

create or replace function public.powerhub_sync_generator_update(p_site_id bigint,p_generator_id bigint,p_name text,p_rated_capacity_kw numeric,p_fuel_level_liters numeric,p_operating_hours numeric,p_status text,p_expected_updated_at timestamptz,p_client_operation_id text)
returns table(id bigint,name text,updated_at timestamptz,replayed boolean) language plpgsql security invoker as $$
declare v_user_id bigint; v_tenant_id bigint; v_role text; v_allowed boolean; v_current public.generators%rowtype; v_updated public.generators%rowtype; v_operation public.offline_sync_operations%rowtype;
begin
 select u.id into v_user_id from public.users u where u.auth_user_id=auth.uid() and u.account_status='active' limit 1; if v_user_id is null then raise exception 'AUTH_USER_NOT_FOUND'; end if;
 select s.tenant_id into v_tenant_id from public.sites s where s.id=p_site_id and s.status<>'archived'; if v_tenant_id is null then raise exception 'SITE_OUT_OF_SCOPE'; end if;
 select case when u.role='admin' then 'owner' else null end into v_role from public.users u where u.id=v_user_id;
 if v_role is null then select 'owner' into v_role from public.tenant_members m where m.tenant_id=v_tenant_id and m.user_id=v_user_id and m.role='owner' and m.is_active and m.membership_status='active' limit 1; end if;
 if v_role is null then select p.role into v_role from public.staff_profiles p where p.tenant_id=v_tenant_id and p.user_id=v_user_id and p.is_active and (p.site_id is null or p.site_id=p_site_id) and ((p.permissions @> '["manageGenerators"]'::jsonb) or p.role in ('owner','manager','technician')) limit 1; end if;
 if v_role is null then raise exception 'GENERATOR_MANAGEMENT_FORBIDDEN'; end if;
 if v_role<>'owner' then select pr.is_allowed into v_allowed from public.platform_role_policies pr where pr.role=v_role and pr.capability='manageGenerators' limit 1; if v_allowed is false then raise exception 'GENERATOR_MANAGEMENT_FORBIDDEN'; end if; end if;
 if p_client_operation_id is null then raise exception 'CLIENT_OPERATION_REQUIRED'; end if;
 select * into v_operation from public.offline_sync_operations o where o.user_id=v_user_id and o.client_operation_id=p_client_operation_id limit 1; if found then if v_operation.operation_type<>'generator_update' then raise exception 'GENERATOR_OPERATION_TYPE_CONFLICT'; end if; return query select (v_operation.response->>'id')::bigint,coalesce(v_operation.response->>'name',''),(v_operation.response->>'updatedAt')::timestamptz,true; return; end if;
 select * into v_current from public.generators g where g.id=p_generator_id and g.tenant_id=v_tenant_id and g.site_id=p_site_id limit 1; if not found then raise exception 'GENERATOR_OUT_OF_SCOPE'; end if;
 if p_expected_updated_at is null or v_current.updated_at<>p_expected_updated_at then raise exception 'GENERATOR_VERSION_CONFLICT'; end if;
 update public.generators set name=trim(p_name),rated_capacity_kw=p_rated_capacity_kw,fuel_level_liters=p_fuel_level_liters,operating_hours=p_operating_hours,status=p_status,updated_at=clock_timestamp() where id=p_generator_id and tenant_id=v_tenant_id and site_id=p_site_id and updated_at=p_expected_updated_at returning * into v_updated;
 if not found then raise exception 'GENERATOR_VERSION_CONFLICT'; end if;
 insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response) values(v_tenant_id,p_site_id,v_user_id,p_client_operation_id,'generator_update','generator',v_updated.id,jsonb_build_object('id',v_updated.id,'name',v_updated.name,'updatedAt',v_updated.updated_at));
 return query select v_updated.id,v_updated.name,v_updated.updated_at,false;
exception when unique_violation then select * into v_operation from public.offline_sync_operations o where o.user_id=v_user_id and o.client_operation_id=p_client_operation_id limit 1; if found and v_operation.operation_type='generator_update' then return query select (v_operation.response->>'id')::bigint,coalesce(v_operation.response->>'name',v_updated.name),(v_operation.response->>'updatedAt')::timestamptz,true; return; end if; raise;
end;$$;
revoke execute on function public.powerhub_sync_generator_create(bigint,text,text,text,numeric,text,text) from public,anon;
revoke execute on function public.powerhub_sync_generator_update(bigint,bigint,text,numeric,numeric,numeric,text,timestamptz,text) from public,anon;
grant execute on function public.powerhub_sync_generator_create(bigint,text,text,text,numeric,text,text) to authenticated;
grant execute on function public.powerhub_sync_generator_update(bigint,bigint,text,numeric,numeric,numeric,text,timestamptz,text) to authenticated;

create or replace function public.powerhub_approve_and_issue_mobile_reading(p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_reading_id bigint,p_base_version integer,p_due_date timestamptz,p_billing_period text,p_discount_amount numeric default 0)
returns table(invoice_id bigint,invoice_no text,total_amount numeric,notification_ids bigint[],already_processed boolean)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_reading public.meter_readings%rowtype; v_subscriber public.subscribers%rowtype; v_site public.sites%rowtype; v_existing public.invoices%rowtype; v_tariff public.tariffs%rowtype; v_platform_role text; v_version integer; v_invoice record; v_notification_id bigint; v_notification_ids bigint[]:=array[]::bigint[]; v_channel text; v_template text; v_recipient text; v_rendered text; v_policy jsonb:='{}'::jsonb; v_whatsapp_enabled boolean:=true; v_sms_enabled boolean:=true; v_policy_enabled boolean:=true; v_has_channel boolean:=false;
begin
 if p_billing_period !~ '^[0-9]{4}-[0-9]{2}$' then raise exception 'INVALID_BILLING_PERIOD' using errcode='P0001'; end if;
 if p_discount_amount<0 then raise exception 'INVALID_DISCOUNT' using errcode='P0001'; end if;
 perform pg_advisory_xact_lock(p_reading_id);
 select r.* into v_reading from public.meter_readings r where r.id=p_reading_id and r.tenant_id=p_tenant_id for update; if not found then raise exception 'READING_OUT_OF_SCOPE' using errcode='P0001'; end if;
 select s.* into v_subscriber from public.subscribers s where s.id=v_reading.subscriber_id and s.tenant_id=p_tenant_id and s.site_id=p_site_id; if not found then raise exception 'READING_OUT_OF_SCOPE' using errcode='P0001'; end if;
 select s.* into v_site from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id; if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
 select i.* into v_existing from public.invoices i where i.reading_id=p_reading_id limit 1; if found and v_reading.status='approved' then return query select v_existing.id,v_existing.invoice_no,v_existing.total_amount,array[]::bigint[],true; return; end if;
 if v_reading.status<>'pending_review' then raise exception 'READING_NOT_PENDING' using errcode='P0001'; end if;
 if v_reading.version_no<>p_base_version then raise exception 'READING_VERSION_CONFLICT' using errcode='P0001'; end if;
 select t.* into v_tariff from public.tariffs t where t.tenant_id=p_tenant_id and t.site_id=p_site_id and t.is_active=true order by t.effective_from desc limit 1; if not found then raise exception 'TARIFF_NOT_FOUND' using errcode='P0001'; end if;
 update public.meter_readings set status='approved',reviewed_by_user_id=p_user_id,reviewed_at=now(),version_no=version_no+1 where id=p_reading_id and tenant_id=p_tenant_id and status='pending_review' and version_no=p_base_version returning version_no into v_version; if v_version is null then raise exception 'READING_VERSION_CONFLICT' using errcode='P0001'; end if;
 select * into v_invoice from public.powerhub_issue_invoice_from_reading(p_tenant_id,p_site_id,p_user_id,p_reading_id,v_tariff.id,p_billing_period,p_due_date,p_discount_amount,null::uuid);
 select platform_role into v_platform_role from public.users where id=p_user_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'meter_reading',p_reading_id::text,'approve',jsonb_build_object('status',v_reading.status,'versionNo',v_reading.version_no),jsonb_build_object('status','approved','versionNo',v_version,'automaticInvoice',true));
 select coalesce(ps.value,'{}'::jsonb),coalesce(ps.is_enabled,true) into v_policy,v_policy_enabled from public.platform_settings ps where ps.setting_key='invoice_delivery_channels' limit 1;
 v_whatsapp_enabled:=coalesce((v_policy->>'whatsappEnabled')::boolean,true); v_sms_enabled:=coalesce((v_policy->>'smsEnabled')::boolean,true);
 for v_channel in select distinct c.channel from public.tenant_messaging_configurations c where c.tenant_id=p_tenant_id and c.is_active=true and v_policy_enabled and ((c.channel='whatsapp' and v_whatsapp_enabled) or (c.channel='sms' and v_sms_enabled)) loop
   v_has_channel:=true; v_recipient:=case when v_channel='whatsapp' then coalesce(v_subscriber.whatsapp_number,v_subscriber.phone) else v_subscriber.phone end;
   select t.body into v_template from public.tenant_invoice_message_templates t where t.tenant_id=p_tenant_id and t.channel=v_channel and t.event_type='invoice_issued' and t.is_active=true order by t.updated_at desc limit 1;
   if v_template is null then v_template:=case when v_channel='whatsapp' then 'مرحباً {{subscriber_name}}، صدرت فاتورتك رقم {{invoice_no}} عن فترة {{billing_period}} بإجمالي {{total_amount}}. تاريخ الاستحقاق: {{due_date}}.' else 'PowerHub: {{subscriber_name}}، فاتورتك {{invoice_no}} للفترة {{billing_period}} بقيمة {{total_amount}}. الاستحقاق: {{due_date}}.' end; end if;
   v_rendered:=replace(replace(replace(replace(replace(v_template,'{{subscriber_name}}',coalesce(v_subscriber.full_name,'')),'{{invoice_no}}',v_invoice.invoice_no),'{{billing_period}}',p_billing_period),'{{total_amount}}',v_invoice.total_amount::text),'{{due_date}}',to_char(p_due_date at time zone 'Asia/Gaza','DD/MM/YYYY'));
   insert into public.notification_messages(tenant_id,invoice_id,subscriber_id,channel,event_type,recipient,status,payload) values(p_tenant_id,v_invoice.invoice_id,v_subscriber.id,v_channel,'invoice_issued',v_recipient,'pending',jsonb_build_object('invoiceNo',v_invoice.invoice_no,'billingPeriod',p_billing_period,'totalAmount',v_invoice.total_amount,'renderedText',v_rendered)) returning id into v_notification_id;
   v_notification_ids:=array_append(v_notification_ids,v_notification_id);
 end loop;
 if not v_has_channel and v_policy_enabled and v_whatsapp_enabled then
   v_rendered:=format('مرحباً %s، صدرت فاتورتك رقم %s عن فترة %s بإجمالي %s. تاريخ الاستحقاق: %s.',coalesce(v_subscriber.full_name,''),v_invoice.invoice_no,p_billing_period,v_invoice.total_amount,to_char(p_due_date at time zone 'Asia/Gaza','DD/MM/YYYY'));
   insert into public.notification_messages(tenant_id,invoice_id,subscriber_id,channel,event_type,recipient,status,payload) values(p_tenant_id,v_invoice.invoice_id,v_subscriber.id,'whatsapp','invoice_issued',coalesce(v_subscriber.whatsapp_number,v_subscriber.phone),'pending',jsonb_build_object('invoiceNo',v_invoice.invoice_no,'billingPeriod',p_billing_period,'totalAmount',v_invoice.total_amount,'renderedText',v_rendered)) returning id into v_notification_id;
   v_notification_ids:=array_append(v_notification_ids,v_notification_id);
 end if;
 return query select v_invoice.invoice_id,v_invoice.invoice_no,v_invoice.total_amount,v_notification_ids,false;
end;$$;
revoke execute on function public.powerhub_approve_and_issue_mobile_reading(bigint,bigint,bigint,bigint,integer,timestamptz,text,numeric) from public,anon,authenticated;
grant execute on function public.powerhub_approve_and_issue_mobile_reading(bigint,bigint,bigint,bigint,integer,timestamptz,text,numeric) to service_role;