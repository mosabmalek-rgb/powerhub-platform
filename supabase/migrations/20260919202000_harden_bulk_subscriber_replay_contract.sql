alter table public.offline_sync_operations
  add column if not exists request_fingerprint text;

alter table public.offline_sync_operations
  drop constraint if exists offline_sync_operations_operation_type_check;

alter table public.offline_sync_operations
  add constraint offline_sync_operations_operation_type_check
  check (operation_type = any (array[
    'subscriber_create','subscriber_update','subscriber_bulk_import','generator_create','generator_update',
    'invoice_issue','payment_create','account_movement_create','account_transfer_create','expense_create',
    'employee_create','site_create','collector_session_open','tariff_create','company_account_create',
    'staff_create','subscription_renew','subscription_update'
  ]));

drop function if exists public.powerhub_bulk_upsert_subscribers(bigint,bigint,bigint,jsonb,boolean,integer);
create function public.powerhub_bulk_upsert_subscribers(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_rows jsonb,
  p_update_existing boolean,
  p_quota_limit integer,
  p_client_operation_id text,
  p_request_fingerprint text
)
returns table(created jsonb,updated jsonb,failed jsonb,replayed boolean)
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  r jsonb; n int; f text; ph text; wa text; ad text; st text; req text;
  sid bigint; mno text; role_name text; cnt int; made int:=0; idx int:=0;
  out_created jsonb:='[]'; out_updated jsonb:='[]'; out_failed jsonb:='[]';
  mid bigint; v_operation public.offline_sync_operations%rowtype; v_response jsonb;
begin
  if nullif(trim(p_client_operation_id),'') is null then raise exception 'INVALID_OPERATION_ID'; end if;
  if nullif(trim(p_request_fingerprint),'') is null then raise exception 'INVALID_REQUEST_FINGERPRINT'; end if;
  if jsonb_typeof(coalesce(p_rows,'[]')) <> 'array' or jsonb_array_length(p_rows)<1 or jsonb_array_length(p_rows)>300 then raise exception 'INVALID_BULK_ROWS' using errcode='P0001'; end if;

  perform pg_advisory_xact_lock(hashtextextended('subscriber-bulk-operation:'||p_user_id::text||':'||trim(p_client_operation_id),0));
  perform pg_advisory_xact_lock(hashtextextended('subscriber-bulk-tenant:'||p_tenant_id::text||':'||p_site_id::text,0));

  select * into v_operation
  from public.offline_sync_operations
  where user_id=p_user_id and client_operation_id=trim(p_client_operation_id)
  for update;

  if found then
    if v_operation.operation_type<>'subscriber_bulk_import'
       or v_operation.request_fingerprint is distinct from p_request_fingerprint
       or v_operation.tenant_id is distinct from p_tenant_id
       or v_operation.site_id is distinct from p_site_id then raise exception 'OPERATION_CONFLICT'; end if;
    v_response:=v_operation.response;
    return query select coalesce(v_response->'created','[]'::jsonb),coalesce(v_response->'updated','[]'::jsonb),coalesce(v_response->'failed','[]'::jsonb),true;
    return;
  end if;

  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select count(*)::int into cnt from public.subscribers where tenant_id=p_tenant_id;
  select platform_role into role_name from public.users where id=p_user_id;

  for r in select value from jsonb_array_elements(p_rows) loop
    idx:=idx+1; n:=coalesce(nullif(r->>'sourceRow','')::int,idx+1);
    f:=trim(coalesce(r->>'fullName','')); ph:=trim(coalesce(r->>'phone','')); wa:=nullif(trim(coalesce(r->>'whatsappNumber','')),'');
    ad:=nullif(trim(coalesce(r->>'address','')),''); st:=lower(trim(coalesce(r->>'subscriptionType','residential')));
    req:=case when p_update_existing then nullif(upper(trim(coalesce(r->>'subscriberNo',''))),'') else null end;
    mid:=null; mno:=null;

    if length(f)<2 then out_failed:=out_failed||jsonb_build_array(jsonb_build_object('sourceRow',n,'fullName',f,'reason','الاسم الكامل قصير جداً.')); continue; end if;
    if length(ph)<5 then out_failed:=out_failed||jsonb_build_array(jsonb_build_object('sourceRow',n,'fullName',f,'reason','رقم الجوال غير صالح.')); continue; end if;
    if st not in ('residential','commercial') then out_failed:=out_failed||jsonb_build_array(jsonb_build_object('sourceRow',n,'fullName',f,'reason','نوع الاشتراك غير صالح.')); continue; end if;

    if req is not null then
      select id,subscriber_no into mid,mno from public.subscribers where tenant_id=p_tenant_id and site_id=p_site_id and upper(subscriber_no)=req limit 1;
    else
      select id,subscriber_no into mid,mno from public.subscribers where tenant_id=p_tenant_id and site_id=p_site_id and lower(trim(full_name))=lower(f) and phone=ph limit 1;
    end if;

    if mid is not null then
      if not p_update_existing then out_failed:=out_failed||jsonb_build_array(jsonb_build_object('sourceRow',n,'fullName',f,'reason','يوجد مشترك مطابق؛ فعّل خيار تحديث المشتركين الموجودين.')); continue; end if;
      update public.subscribers set full_name=f,phone=ph,whatsapp_number=wa,address=ad,subscription_type=st,updated_at=now() where id=mid and tenant_id=p_tenant_id and site_id=p_site_id;
      out_updated:=out_updated||jsonb_build_array(jsonb_build_object('id',mid,'sourceRow',n,'fullName',f,'subscriberNo',mno));
      continue;
    end if;

    if cnt+made>=p_quota_limit then out_failed:=out_failed||jsonb_build_array(jsonb_build_object('sourceRow',n,'fullName',f,'reason','يتجاوز هذا الصف الحد المتاح للمشتركين في الباقة.')); continue; end if;

    mno:=format('SUB-%s',lpad(nextval('public.subscriber_global_number_seq')::text,6,'0'));
    insert into public.subscribers(tenant_id,site_id,subscriber_no,full_name,phone,whatsapp_number,address,subscription_type)
    values(p_tenant_id,p_site_id,mno,f,ph,wa,ad,st) returning id into sid;

    insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
    values(p_tenant_id,p_site_id,p_user_id,role_name,'subscriber',sid::text,'bulk_import_create',jsonb_build_object('fullName',f,'phone',ph,'subscriberNo',mno,'sourceRow',n));

    made:=made+1;
    out_created:=out_created||jsonb_build_array(jsonb_build_object('id',sid,'sourceRow',n,'fullName',f,'subscriberNo',mno));
  end loop;

  v_response:=jsonb_build_object('created',out_created,'updated',out_updated,'failed',out_failed);

  insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response,request_fingerprint)
  values(p_tenant_id,p_site_id,p_user_id,trim(p_client_operation_id),'subscriber_bulk_import','subscriber_bulk_import',p_site_id,v_response,p_request_fingerprint);

  return query select out_created,out_updated,out_failed,false;
end;
$function$;

revoke all on function public.powerhub_bulk_upsert_subscribers(bigint,bigint,bigint,jsonb,boolean,integer,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_bulk_upsert_subscribers(bigint,bigint,bigint,jsonb,boolean,integer,text,text) to service_role;