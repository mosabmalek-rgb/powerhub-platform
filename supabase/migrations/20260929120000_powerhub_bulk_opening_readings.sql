-- PowerHub: optional opening meter readings during bulk subscriber import.
-- Opening readings establish the baseline only; they never create invoices.
alter table public.meter_readings
  add column if not exists is_opening_baseline boolean not null default false;

create index if not exists meter_readings_opening_baseline_idx
  on public.meter_readings (tenant_id, subscriber_id, is_opening_baseline, reading_at desc);

-- Prevent an opening baseline from entering invoice issuance, even if a client
-- later attempts to issue an invoice against its reading id.
create or replace function public.powerhub_block_opening_baseline_invoice()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.reading_id is not null and exists (select 1 from public.meter_readings where id = new.reading_id and is_opening_baseline) then
    raise exception 'OPENING_BASELINE_NOT_BILLABLE' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_block_opening_baseline on public.invoices;
create trigger invoices_block_opening_baseline
before insert or update of reading_id on public.invoices
for each row execute function public.powerhub_block_opening_baseline_invoice();
revoke execute on function public.powerhub_block_opening_baseline_invoice() from public, anon, authenticated;
grant execute on function public.powerhub_block_opening_baseline_invoice() to service_role;

-- Re-declare the bulk RPC with the same signature. New optional row keys:
-- openingReading, openingReadingAt, openingReadingApproved.
create or replace function public.powerhub_bulk_upsert_subscribers(p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_rows jsonb,p_update_existing boolean,p_quota_limit integer)
returns table (created jsonb, updated jsonb, failed jsonb) language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_row jsonb; v_source_row integer; v_full_name text; v_phone text; v_whatsapp text; v_address text; v_subscription_type text; v_requested_no text; v_subscriber_id bigint; v_match_no text; v_platform_role text; v_current_count integer; v_created_count integer:=0; v_created jsonb:='[]'::jsonb; v_updated jsonb:='[]'::jsonb; v_failed jsonb:='[]'::jsonb; v_match_id bigint; v_index integer:=0; v_feature_policy record; v_opening_reading numeric(15,3); v_opening_at timestamptz; v_opening_approved boolean; v_baseline_id bigint; v_actor_site_role text;
begin
 if jsonb_typeof(coalesce(p_rows,'[]'::jsonb))<>'array' or jsonb_array_length(p_rows)<1 or jsonb_array_length(p_rows)>300 then raise exception 'INVALID_BULK_ROWS' using errcode='P0001'; end if;
 perform pg_advisory_xact_lock(p_tenant_id); if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
 select * into v_feature_policy from public.powerhub_resolve_tenant_feature_policy(p_tenant_id,'subscriber_management'); if not coalesce(v_feature_policy.eligible,false) or not coalesce(v_feature_policy.enabled,false) then raise exception 'SUBSCRIBER_FEATURE_DISABLED' using errcode='P0001'; end if;
 select count(*)::integer into v_current_count from public.subscribers where tenant_id=p_tenant_id; select platform_role into v_platform_role from public.users where id=p_user_id; select role into v_actor_site_role from public.staff_profiles where user_id=p_user_id and tenant_id=p_tenant_id and site_id=p_site_id and is_active=true limit 1;
 for v_row in select value from jsonb_array_elements(p_rows) loop
  v_index:=v_index+1; v_source_row:=coalesce(nullif(v_row->>'sourceRow','')::integer,v_index+1); v_full_name:=trim(coalesce(v_row->>'fullName','')); v_phone:=trim(coalesce(v_row->>'phone','')); v_whatsapp:=nullif(trim(coalesce(v_row->>'whatsappNumber','')),''); v_address:=nullif(trim(coalesce(v_row->>'address','')),''); v_subscription_type:=lower(trim(coalesce(v_row->>'subscriptionType','residential'))); v_requested_no:=case when p_update_existing then nullif(upper(regexp_replace(trim(coalesce(v_row->>'subscriberNo','')),'\s+','','g')),'') else null end; v_match_id:=null; v_match_no:=null;
  v_opening_reading:=nullif(trim(coalesce(v_row->>'openingReading','')),'')::numeric; v_opening_at:=coalesce(nullif(v_row->>'openingReadingAt','')::timestamptz,now()); v_opening_approved:=coalesce((v_row->>'openingReadingApproved')::boolean,false);
  if v_opening_reading is not null and v_opening_reading<0 then v_failed:=v_failed||jsonb_build_array(jsonb_build_object('sourceRow',v_source_row,'fullName',v_full_name,'reason','القراءة الافتتاحية لا يمكن أن تكون سالبة.')); continue; end if;
  if v_opening_reading is not null and v_opening_approved and coalesce(v_actor_site_role,'') <> 'owner' then v_failed:=v_failed||jsonb_build_array(jsonb_build_object('sourceRow',v_source_row,'fullName',v_full_name,'reason','اعتماد القراءة الافتتاحية مباشرة متاح لمالك مساحة المولد فقط.')); continue; end if;
  if length(v_full_name)<2 then v_failed:=v_failed||jsonb_build_array(jsonb_build_object('sourceRow',v_source_row,'fullName',v_full_name,'reason','الاسم الكامل قصير جداً.')); continue; end if;
  if length(v_phone)<5 then v_failed:=v_failed||jsonb_build_array(jsonb_build_object('sourceRow',v_source_row,'fullName',v_full_name,'reason','رقم الجوال غير صالح.')); continue; end if;
  if v_subscription_type not in ('residential','commercial') then v_failed:=v_failed||jsonb_build_array(jsonb_build_object('sourceRow',v_source_row,'fullName',v_full_name,'reason','نوع الاشتراك غير صالح.')); continue; end if;
  if v_requested_no is not null then select id,subscriber_no into v_match_id,v_match_no from public.subscribers where tenant_id=p_tenant_id and site_id=p_site_id and upper(regexp_replace(subscriber_no,'\s+','','g'))=v_requested_no limit 1; else select id,subscriber_no into v_match_id,v_match_no from public.subscribers where tenant_id=p_tenant_id and site_id=p_site_id and lower(trim(full_name))=lower(v_full_name) and phone=v_phone limit 1; end if;
  if v_match_id is not null then
   if v_opening_reading is not null then v_failed:=v_failed||jsonb_build_array(jsonb_build_object('sourceRow',v_source_row,'fullName',v_full_name,'reason','القراءة الافتتاحية مخصصة للمشترك الجديد فقط؛ لا تُستبدل بها قراءة تاريخية.')); continue; end if;
   if not p_update_existing then v_failed:=v_failed||jsonb_build_array(jsonb_build_object('sourceRow',v_source_row,'fullName',v_full_name,'reason','يوجد مشترك مطابق؛ فعّل خيار تحديث المشتركين الموجودين.')); continue; end if;
   update public.subscribers set full_name=v_full_name,phone=v_phone,whatsapp_number=v_whatsapp,address=v_address,subscription_type=v_subscription_type,updated_at=now() where id=v_match_id and tenant_id=p_tenant_id and site_id=p_site_id; v_updated:=v_updated||jsonb_build_array(jsonb_build_object('id',v_match_id,'sourceRow',v_source_row,'fullName',v_full_name,'subscriberNo',v_match_no)); continue;
  end if;
  if v_feature_policy.effective_limit is not null and v_current_count+v_created_count>=v_feature_policy.effective_limit then v_failed:=v_failed||jsonb_build_array(jsonb_build_object('sourceRow',v_source_row,'fullName',v_full_name,'reason','يتجاوز هذا الصف الحد المتاح للمشتركين.')); continue; end if;
  v_match_no:=format('SUB-%s',lpad(nextval('public.subscriber_global_number_seq')::text,6,'0'));
  insert into public.subscribers(tenant_id,site_id,subscriber_no,full_name,phone,whatsapp_number,address,subscription_type) values(p_tenant_id,p_site_id,v_match_no,v_full_name,v_phone,v_whatsapp,v_address,v_subscription_type) returning id into v_subscriber_id;
  if v_opening_reading is not null then insert into public.meter_readings(tenant_id,subscriber_id,reading_at,reading_value,previous_reading_value,consumption_kwh,capture_method,status,entered_by_user_id,reviewed_by_user_id,reviewed_at,notes,is_opening_baseline) values(p_tenant_id,v_subscriber_id,v_opening_at,v_opening_reading,null,0,'manual',case when v_opening_approved then 'approved' else 'pending_review' end,p_user_id,case when v_opening_approved then p_user_id else null end,case when v_opening_approved then now() else null end,'قراءة افتتاحية عند الاستيراد الجماعي',true) returning id into v_baseline_id; end if;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'subscriber',v_subscriber_id::text,'bulk_import_create',jsonb_build_object('fullName',v_full_name,'phone',v_phone,'subscriberNo',v_match_no,'sourceRow',v_source_row,'openingReading',v_opening_reading,'openingReadingId',v_baseline_id,'openingReadingApproved',v_opening_approved));
  v_created_count:=v_created_count+1; v_created:=v_created||jsonb_build_array(jsonb_build_object('id',v_subscriber_id,'sourceRow',v_source_row,'fullName',v_full_name,'subscriberNo',v_match_no,'openingReadingId',v_baseline_id,'openingReadingStatus',case when v_opening_reading is null then null when v_opening_approved then 'approved' else 'pending_review' end));
 end loop;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'subscriber_import','bulk-'||gen_random_uuid()::text,'bulk_import',jsonb_build_object('requested',jsonb_array_length(p_rows),'created',jsonb_array_length(v_created),'updated',jsonb_array_length(v_updated),'failed',jsonb_array_length(v_failed),'updateExisting',p_update_existing));
 return query select v_created,v_updated,v_failed;
end;$$;
revoke all on function public.powerhub_bulk_upsert_subscribers(bigint,bigint,bigint,jsonb,boolean,integer) from public,anon,authenticated; grant execute on function public.powerhub_bulk_upsert_subscribers(bigint,bigint,bigint,jsonb,boolean,integer) to service_role;
