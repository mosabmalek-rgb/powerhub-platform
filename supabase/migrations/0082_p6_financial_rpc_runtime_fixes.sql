-- P6 live rehearsal fixes: runtime correctness issues discovered on isolated staging.
-- These corrections are intentionally additive; they do not mutate production.

alter table public.audit_logs add column if not exists actor_platform_role text;
alter table public.audit_logs add column if not exists actor_tenant_role text;
alter table public.audit_logs alter column entity_id type text using entity_id::text;

alter table public.invoices drop constraint if exists invoices_billing_period_check;
alter table public.invoices add constraint invoices_billing_period_check check (billing_period ~ '^[0-9]{4}-[0-9]{2}$');

create or replace function public.powerhub_create_reading(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_subscriber_id bigint,p_client_operation_id uuid,
  p_reading_at timestamptz,p_reading_value numeric,p_capture_method text,p_image_key text,p_image_hash text,
  p_notes text,p_is_reading_reset boolean,p_field_verified boolean,p_can_override_same_day boolean
)
returns table(reading_id bigint,consumption_kwh numeric,status text,replayed boolean)
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_subscriber public.subscribers%rowtype; v_existing public.meter_readings%rowtype; v_previous_value numeric:=0; v_consumption numeric; v_notes text; v_reading_id bigint; v_platform_role text; v_day_start timestamptz; v_day_end timestamptz;
begin
 perform pg_advisory_xact_lock(p_subscriber_id);
 select * into v_subscriber from public.subscribers where id=p_subscriber_id and tenant_id=p_tenant_id and site_id=p_site_id and service_status='active' for update;
 if not found then raise exception 'SUBSCRIBER_OUT_OF_SCOPE_OR_INACTIVE' using errcode='P0001'; end if;
 if p_client_operation_id is not null then select * into v_existing from public.meter_readings where client_operation_id=p_client_operation_id::text limit 1; if found then return query select v_existing.id,coalesce(v_existing.consumption_kwh,0),v_existing.status,true; return; end if; end if;
 v_day_start:=date_trunc('day',p_reading_at at time zone 'UTC') at time zone 'UTC'; v_day_end:=v_day_start+interval '1 day';
 if exists(select 1 from public.meter_readings mr where mr.subscriber_id=p_subscriber_id and mr.reading_at>=v_day_start and mr.reading_at<v_day_end and mr.status<>'rejected') and not p_can_override_same_day then raise exception 'SAME_DAY_READING_EXISTS' using errcode='P0001'; end if;
 select coalesce(mr.reading_value,0) into v_previous_value from public.meter_readings mr where mr.subscriber_id=p_subscriber_id and mr.status='approved' order by mr.reading_at desc limit 1;
 v_previous_value:=coalesce(v_previous_value,0);
 if p_reading_value<v_previous_value and not p_is_reading_reset then raise exception 'READING_BELOW_PREVIOUS' using errcode='P0001'; end if;
 if p_reading_value<v_previous_value and coalesce(trim(p_notes),'')='' then raise exception 'READING_RESET_NOTES_REQUIRED' using errcode='P0001'; end if;
 v_consumption:=case when p_is_reading_reset and p_reading_value<v_previous_value then p_reading_value else p_reading_value-v_previous_value end;
 v_notes:=concat_ws(' ',case when p_is_reading_reset then '[إعادة ضبط سجل القراءة]' end,case when p_field_verified then '[تم التحقق ميدانياً]' end,nullif(trim(p_notes),''));
 insert into public.meter_readings(tenant_id,subscriber_id,client_operation_id,reading_at,reading_value,previous_reading_value,consumption_kwh,capture_method,image_key,image_hash,notes,entered_by_user_id) values(p_tenant_id,p_subscriber_id,p_client_operation_id::text,p_reading_at,p_reading_value,nullif(v_previous_value,0),v_consumption,p_capture_method,nullif(p_image_key,''),nullif(p_image_hash,''),nullif(v_notes,''),p_user_id) returning id into v_reading_id;
 select platform_role into v_platform_role from public.users where id=p_user_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'meter_reading',v_reading_id::text,'create',jsonb_build_object('subscriberId',p_subscriber_id,'readingAt',p_reading_at,'readingValue',p_reading_value,'consumptionKwh',v_consumption));
 return query select v_reading_id,v_consumption,'pending_review'::text,false;
end;$$;
revoke execute on function public.powerhub_create_reading(bigint,bigint,bigint,bigint,uuid,timestamptz,numeric,text,text,text,text,boolean,boolean,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_create_reading(bigint,bigint,bigint,bigint,uuid,timestamptz,numeric,text,text,text,text,boolean,boolean,boolean) to service_role;

create or replace function public.powerhub_approve_reading(p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_reading_id bigint,p_base_version integer)
returns table(reading_id bigint,version_no integer) language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_reading public.meter_readings%rowtype; v_platform_role text; v_version integer;
begin
 perform pg_advisory_xact_lock(p_reading_id);
 select r.* into v_reading from public.meter_readings r join public.subscribers s on s.id=r.subscriber_id where r.id=p_reading_id and r.tenant_id=p_tenant_id and s.site_id=p_site_id for update of r;
 if not found then raise exception 'READING_OUT_OF_SCOPE' using errcode='P0001'; end if;
 if v_reading.status<>'pending_review' then raise exception 'READING_NOT_PENDING' using errcode='P0001'; end if;
 if v_reading.version_no<>p_base_version then raise exception 'READING_VERSION_CONFLICT' using errcode='P0001'; end if;
 update public.meter_readings mr set status='approved',reviewed_by_user_id=p_user_id,reviewed_at=now(),version_no=mr.version_no+1 where mr.id=p_reading_id returning mr.version_no into v_version;
 select platform_role into v_platform_role from public.users where id=p_user_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'meter_reading',p_reading_id::text,'approve',jsonb_build_object('status',v_reading.status,'versionNo',v_reading.version_no),jsonb_build_object('status','approved','versionNo',v_version));
 return query select p_reading_id,v_version;
end;$$;
revoke execute on function public.powerhub_approve_reading(bigint,bigint,bigint,bigint,integer) from public,anon,authenticated;
grant execute on function public.powerhub_approve_reading(bigint,bigint,bigint,bigint,integer) to service_role;

create or replace function public.powerhub_issue_invoice_from_reading(p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_reading_id bigint,p_tariff_id bigint,p_billing_period text,p_due_date timestamptz,p_discount_amount numeric,p_client_operation_id uuid)
returns table(invoice_id bigint,invoice_no text,total_amount numeric,replayed boolean) language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_reading public.meter_readings%rowtype; v_subscriber public.subscribers%rowtype; v_site public.sites%rowtype; v_tariff public.tariffs%rowtype; v_existing public.invoices%rowtype; v_response jsonb; v_invoice_id bigint; v_invoice_no text; v_energy_amount numeric(14,2); v_tax_amount numeric(14,2); v_total_amount numeric(14,2); v_platform_role text; v_sequence integer;
begin
 if p_billing_period !~ '^[0-9]{4}-[0-9]{2}$' then raise exception 'INVALID_BILLING_PERIOD' using errcode='P0001'; end if;
 if p_discount_amount<0 then raise exception 'INVALID_DISCOUNT' using errcode='P0001'; end if;
 if p_client_operation_id is not null then select response into v_response from public.offline_sync_operations where user_id=p_user_id and client_operation_id=p_client_operation_id::text limit 1; if found then if coalesce(v_response->>'id','')='' or coalesce(v_response->>'invoiceNo','')='' then raise exception 'INVALID_INVOICE_OPERATION_REPLAY' using errcode='P0001'; end if; return query select (v_response->>'id')::bigint,v_response->>'invoiceNo',(v_response->>'totalAmount')::numeric,true; return; end if; end if;
 perform pg_advisory_xact_lock(p_reading_id);
 select r.* into v_reading from public.meter_readings r where r.id=p_reading_id and r.tenant_id=p_tenant_id for update; if not found then raise exception 'READING_OUT_OF_SCOPE' using errcode='P0001'; end if;
 select * into v_subscriber from public.subscribers where id=v_reading.subscriber_id and tenant_id=p_tenant_id and site_id=p_site_id; if not found then raise exception 'READING_OUT_OF_SCOPE' using errcode='P0001'; end if;
 select * into v_site from public.sites where id=p_site_id and tenant_id=p_tenant_id; if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
 if v_reading.status<>'approved' then raise exception 'READING_NOT_APPROVED' using errcode='P0001'; end if;
 select * into v_existing from public.invoices where reading_id=p_reading_id limit 1; if found then return query select v_existing.id,v_existing.invoice_no,v_existing.total_amount,true; return; end if;
 if exists(select 1 from public.financial_settlements where tenant_id=p_tenant_id and site_id=p_site_id and status='locked' and period_start<=p_due_date and period_end>=p_due_date) then raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001'; end if;
 select * into v_tariff from public.tariffs where id=p_tariff_id and tenant_id=p_tenant_id and site_id=p_site_id and is_active=true; if not found then raise exception 'TARIFF_NOT_FOUND' using errcode='P0001'; end if;
 perform pg_advisory_xact_lock(p_site_id::integer,hashtext(p_billing_period));
 select count(*)::integer+1 into v_sequence from public.invoices where site_id=p_site_id;
 v_invoice_no:=format('PH-%s-%s-%s',upper(regexp_replace(v_site.code,'[^A-Za-z0-9]','','g')),replace(p_billing_period,'-',''),lpad(v_sequence::text,5,'0'));
 v_energy_amount:=round(coalesce(v_reading.consumption_kwh,0)*v_tariff.price_per_kwh,2);
 v_tax_amount:=round((v_energy_amount+v_tariff.fixed_fee)*(v_tariff.tax_rate/100),2);
 v_total_amount:=greatest(0,round(v_energy_amount+v_tariff.fixed_fee+v_tax_amount-p_discount_amount,2));
 insert into public.invoices(tenant_id,site_id,subscriber_id,reading_id,tariff_id,invoice_no,client_operation_id,billing_period,due_date,previous_reading,current_reading,consumption_kwh,price_per_kwh,fixed_fee,tax_amount,discount_amount,total_amount,balance_due,status,created_by_user_id) values(p_tenant_id,p_site_id,v_subscriber.id,p_reading_id,v_tariff.id,v_invoice_no,p_client_operation_id::text,p_billing_period,p_due_date,v_reading.previous_reading_value,v_reading.reading_value,coalesce(v_reading.consumption_kwh,0),v_tariff.price_per_kwh,v_tariff.fixed_fee,v_tax_amount,p_discount_amount,v_total_amount,v_total_amount,'issued',p_user_id) returning id into v_invoice_id;
 insert into public.invoice_lines(tenant_id,invoice_id,line_type,description,quantity,unit_price,amount,display_order) values(p_tenant_id,v_invoice_id,'energy','استهلاك الكهرباء',coalesce(v_reading.consumption_kwh,0),v_tariff.price_per_kwh,v_energy_amount,1),(p_tenant_id,v_invoice_id,'fixed_fee','رسم ثابت',1,v_tariff.fixed_fee,v_tariff.fixed_fee,2),(p_tenant_id,v_invoice_id,'tax','الضريبة',1,v_tariff.tax_rate,v_tax_amount,3);
 if p_discount_amount>0 then insert into public.invoice_lines(tenant_id,invoice_id,line_type,description,quantity,unit_price,amount,display_order) values(p_tenant_id,v_invoice_id,'discount','خصم',1,p_discount_amount,p_discount_amount,4); end if;
 select platform_role into v_platform_role from public.users where id=p_user_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'invoice',v_invoice_id::text,'issue',jsonb_build_object('readingId',p_reading_id,'tariffId',p_tariff_id,'invoiceNo',v_invoice_no,'billingPeriod',p_billing_period,'totalAmount',v_total_amount,'deliveryQueued',false));
 if p_client_operation_id is not null then insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response) values(p_tenant_id,p_site_id,p_user_id,p_client_operation_id::text,'invoice_issue','invoice',v_invoice_id,jsonb_build_object('id',v_invoice_id,'invoiceNo',v_invoice_no,'totalAmount',v_total_amount)); end if;
 return query select v_invoice_id,v_invoice_no,v_total_amount,false;
end;$$;
revoke execute on function public.powerhub_issue_invoice_from_reading(bigint,bigint,bigint,bigint,bigint,text,timestamptz,numeric,uuid) from public,anon,authenticated;
grant execute on function public.powerhub_issue_invoice_from_reading(bigint,bigint,bigint,bigint,bigint,text,timestamptz,numeric,uuid) to service_role;
