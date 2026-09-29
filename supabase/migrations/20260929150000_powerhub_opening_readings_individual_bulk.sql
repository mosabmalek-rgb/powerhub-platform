-- PowerHub: opening meter baseline for individual and bulk subscriber creation.
-- The baseline is never billable and is written atomically with subscriber creation/import.

alter table public.meter_readings
  add column if not exists is_opening_baseline boolean not null default false;

create index if not exists meter_readings_opening_baseline_idx
  on public.meter_readings (tenant_id, subscriber_id, is_opening_baseline, reading_at desc);

create or replace function public.powerhub_block_opening_baseline_invoice()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.reading_id is not null
     and exists (
       select 1 from public.meter_readings mr
       where mr.id = new.reading_id
         and mr.is_opening_baseline = true
     ) then
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

create or replace function public.powerhub_create_subscriber_with_opening_reading(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_full_name text,
  p_phone text,
  p_whatsapp_number text,
  p_address text,
  p_subscription_type text,
  p_client_operation_id uuid,
  p_quota_limit integer,
  p_opening_reading numeric,
  p_opening_reading_at timestamptz,
  p_opening_image_key text,
  p_opening_image_hash text,
  p_opening_reading_approved boolean
)
returns table (
  subscriber_id bigint,
  subscriber_no text,
  opening_reading_id bigint,
  opening_reading_status text,
  replayed boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_subscriber_id bigint;
  v_subscriber_no text;
  v_reading_id bigint;
  v_response jsonb;
  v_platform_role text;
  v_current_count integer;
  v_effective_limit integer;
  v_owner boolean := false;
begin
  if p_client_operation_id is not null then
    select response into v_response
    from public.offline_sync_operations
    where user_id = p_user_id
      and client_operation_id = p_client_operation_id::text
    limit 1;

    if found then
      if coalesce(v_response->>'id','') = '' then
        raise exception 'INVALID_SUBSCRIBER_OPERATION_REPLAY';
      end if;
      return query select
        (v_response->>'id')::bigint,
        v_response->>'subscriberNo',
        null::bigint,
        null::text,
        true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(p_tenant_id);

  if not exists (
    select 1 from public.sites
    where id = p_site_id and tenant_id = p_tenant_id and status <> 'archived'
  ) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  if p_full_name is null or length(trim(p_full_name)) < 2 then
    raise exception 'INVALID_SUBSCRIBER_NAME' using errcode = 'P0001';
  end if;
  if p_phone is null or length(trim(p_phone)) < 5 then
    raise exception 'INVALID_SUBSCRIBER_PHONE' using errcode = 'P0001';
  end if;
  if p_subscription_type not in ('residential','commercial') then
    raise exception 'INVALID_SUBSCRIPTION_TYPE' using errcode = 'P0001';
  end if;
  if p_opening_reading is null and (p_opening_image_key is not null or p_opening_image_hash is not null or p_opening_reading_approved) then
    raise exception 'OPENING_READING_REQUIRED' using errcode = 'P0001';
  end if;
  if p_opening_reading is not null and p_opening_reading < 0 then
    raise exception 'INVALID_OPENING_READING' using errcode = 'P0001';
  end if;

  select exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = p_tenant_id
      and tm.user_id = p_user_id
      and tm.role = 'owner'
      and tm.is_active
      and tm.membership_status = 'active'
  ) or exists (
    select 1 from public.users u
    where u.id = p_user_id and u.role = 'admin' and u.account_status = 'active'
  ) into v_owner;

  if p_opening_reading_approved and not v_owner then
    raise exception 'OPENING_READING_OWNER_REQUIRED' using errcode = 'P0001';
  end if;

  select count(*)::integer into v_current_count
  from public.subscribers where tenant_id = p_tenant_id;
  v_effective_limit := public.powerhub_effective_tenant_quota(p_tenant_id,'subscribers');
  if v_current_count >= v_effective_limit then
    raise exception 'SUBSCRIBER_QUOTA_REACHED' using errcode = 'P0001';
  end if;

  v_subscriber_no := format('SUB-%s', lpad(nextval('public.subscriber_global_number_seq')::text,6,'0'));

  insert into public.subscribers (
    tenant_id, site_id, subscriber_no, client_operation_id, full_name, phone,
    whatsapp_number, address, subscription_type
  ) values (
    p_tenant_id, p_site_id, v_subscriber_no, p_client_operation_id::text,
    trim(p_full_name), trim(p_phone), nullif(trim(p_whatsapp_number),''),
    nullif(trim(p_address),''), p_subscription_type
  )
  returning id, subscriber_no into v_subscriber_id, v_subscriber_no;

  if p_opening_reading is not null then
    insert into public.meter_readings (
      tenant_id, subscriber_id, reading_at, reading_value,
      previous_reading_value, consumption_kwh, capture_method,
      image_key, image_hash, status, entered_by_user_id,
      reviewed_by_user_id, reviewed_at, notes, is_opening_baseline
    ) values (
      p_tenant_id, v_subscriber_id, coalesce(p_opening_reading_at, now()),
      p_opening_reading, null, 0,
      case when nullif(trim(coalesce(p_opening_image_key,'')),'') is null then 'manual' else 'photo' end,
      nullif(trim(coalesce(p_opening_image_key,'')),''),
      nullif(trim(coalesce(p_opening_image_hash,'')),''),
      case when p_opening_reading_approved then 'approved' else 'pending_review' end,
      p_user_id,
      case when p_opening_reading_approved then p_user_id else null end,
      case when p_opening_reading_approved then now() else null end,
      'قراءة افتتاحية عند إضافة المشترك',
      true
    )
    returning id into v_reading_id;
  end if;

  select platform_role into v_platform_role
  from public.users where id = p_user_id;

  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role,
    entity_type, entity_id, action, after_data
  ) values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role,
    'subscriber', v_subscriber_id::text, 'create_with_opening_reading',
    jsonb_build_object(
      'siteId', p_site_id,
      'subscriberNo', v_subscriber_no,
      'openingReadingId', v_reading_id,
      'openingReading', p_opening_reading,
      'openingReadingStatus', case when p_opening_reading is null then null when p_opening_reading_approved then 'approved' else 'pending_review' end
    )
  );

  if p_client_operation_id is not null then
    insert into public.offline_sync_operations (
      tenant_id, site_id, user_id, client_operation_id,
      operation_type, entity_type, entity_id, response
    ) values (
      p_tenant_id, p_site_id, p_user_id, p_client_operation_id::text,
      'subscriber_create', 'subscriber', v_subscriber_id,
      jsonb_build_object(
        'id', v_subscriber_id,
        'subscriberNo', v_subscriber_no,
        'referenceNotifications', jsonb_build_array()
      )
    );
  end if;

  return query select
    v_subscriber_id,
    v_subscriber_no,
    v_reading_id,
    case when p_opening_reading is null then null
         when p_opening_reading_approved then 'approved'
         else 'pending_review' end,
    false;

exception when unique_violation then
  if p_client_operation_id is not null then
    select id, subscriber_no into v_subscriber_id, v_subscriber_no
    from public.subscribers
    where client_operation_id = p_client_operation_id::text
    limit 1;
    if found then
      return query select v_subscriber_id, v_subscriber_no, null::bigint, null::text, true;
      return;
    end if;
  end if;
  raise;
end;
$$;

revoke all on function public.powerhub_create_subscriber_with_opening_reading(
  bigint,bigint,bigint,text,text,text,text,text,uuid,integer,numeric,timestamptz,text,text,boolean
) from public, anon, authenticated;
grant execute on function public.powerhub_create_subscriber_with_opening_reading(
  bigint,bigint,bigint,text,text,text,text,text,uuid,integer,numeric,timestamptz,text,text,boolean
) to service_role;

-- Preserve the Production bulk RPC contract (8 arguments, idempotency + request fingerprint)
-- while adding optional opening baseline creation for newly created subscribers.
create or replace function public.powerhub_bulk_upsert_subscribers(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_rows jsonb,
  p_update_existing boolean,
  p_quota_limit integer,
  p_client_operation_id text,
  p_request_fingerprint text
)
returns table(created jsonb, updated jsonb, failed jsonb, replayed boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  r jsonb;
  n int;
  f text;
  ph text;
  wa text;
  ad text;
  st text;
  req text;
  sid bigint;
  mno text;
  role_name text;
  cnt int;
  made int := 0;
  idx int := 0;
  out_created jsonb := '[]';
  out_updated jsonb := '[]';
  out_failed jsonb := '[]';
  mid bigint;
  v_operation public.offline_sync_operations%rowtype;
  v_response jsonb;
  v_opening_reading numeric;
  v_opening_at timestamptz;
  v_opening_approved boolean;
  v_baseline_id bigint;
  v_owner boolean := false;
begin
  if nullif(trim(p_client_operation_id),'') is null then raise exception 'INVALID_OPERATION_ID'; end if;
  if nullif(trim(p_request_fingerprint),'') is null then raise exception 'INVALID_REQUEST_FINGERPRINT'; end if;
  if jsonb_typeof(coalesce(p_rows,'[]')) <> 'array' or jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 300 then raise exception 'INVALID_BULK_ROWS'; end if;

  perform pg_advisory_xact_lock(hashtextextended('subscriber-bulk-operation:'||p_user_id||':'||trim(p_client_operation_id),0));

  select * into v_operation
  from public.offline_sync_operations
  where user_id=p_user_id and client_operation_id=trim(p_client_operation_id)
  for update;

  if found then
    if v_operation.operation_type <> 'subscriber_bulk_import'
       or v_operation.request_fingerprint is distinct from p_request_fingerprint
       or v_operation.tenant_id is distinct from p_tenant_id
       or v_operation.site_id is distinct from p_site_id then
      raise exception 'OPERATION_CONFLICT';
    end if;
    v_response := v_operation.response;
    return query select coalesce(v_response->'created','[]'::jsonb),coalesce(v_response->'updated','[]'::jsonb),coalesce(v_response->'failed','[]'::jsonb),true;
    return;
  end if;

  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id and status <> 'archived') then raise exception 'SITE_OUT_OF_SCOPE'; end if;

  select count(*)::int into cnt from public.subscribers where tenant_id=p_tenant_id;
  select platform_role into role_name from public.users where id=p_user_id;

  select exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id=p_tenant_id and tm.user_id=p_user_id
      and tm.role='owner' and tm.is_active and tm.membership_status='active'
  ) or exists (
    select 1 from public.users u
    where u.id=p_user_id and u.role='admin' and u.account_status='active'
  ) into v_owner;

  for r in select value from jsonb_array_elements(p_rows) loop
    idx:=idx+1;
    n:=coalesce(nullif(r->>'sourceRow','')::int,idx+1);
    f:=trim(coalesce(r->>'fullName',''));
    ph:=trim(coalesce(r->>'phone',''));
    wa:=nullif(trim(coalesce(r->>'whatsappNumber','')),'');
    ad:=nullif(trim(coalesce(r->>'address','')),'');
    st:=lower(trim(coalesce(r->>'subscriptionType','residential')));
    req:=case when p_update_existing then nullif(upper(trim(coalesce(r->>'subscriberNo',''))),'') else null end;
    v_opening_reading:=nullif(trim(coalesce(r->>'openingReading','')),'')::numeric;
    v_opening_at:=coalesce(nullif(r->>'openingReadingAt','')::timestamptz,now());
    v_opening_approved:=coalesce((r->>'openingReadingApproved')::boolean,false);

    if v_opening_reading is not null and v_opening_reading < 0 then
      out_failed:=out_failed||jsonb_build_array(jsonb_build_object('sourceRow',n,'fullName',f,'reason','القراءة الافتتاحية لا يمكن أن تكون سالبة.'));
      continue;
    end if;
    if v_opening_reading is null and v_opening_approved then
      out_failed:=out_failed||jsonb_build_array(jsonb_build_object('sourceRow',n,'fullName',f,'reason','أدخل القراءة الافتتاحية قبل اعتمادها.'));
      continue;
    end if;
    if v_opening_approved and not v_owner then
      out_failed:=out_failed||jsonb_build_array(jsonb_build_object('sourceRow',n,'fullName',f,'reason','اعتماد القراءة الافتتاحية مباشرة متاح لمالك مساحة المولد فقط.'));
      continue;
    end if;
    if length(f)<2 then out_failed:=out_failed||jsonb_build_array(jsonb_build_object('sourceRow',n,'fullName',f,'reason','الاسم الكامل قصير جداً.')); continue; end if;
    if length(ph)<5 then out_failed:=out_failed||jsonb_build_array(jsonb_build_object('sourceRow',n,'fullName',f,'reason','رقم الجوال غير صالح.')); continue; end if;
    if st not in ('residential','commercial') then out_failed:=out_failed||jsonb_build_array(jsonb_build_object('sourceRow',n,'fullName',f,'reason','نوع الاشتراك غير صالح.')); continue; end if;

    if req is not null then
      select id,subscriber_no into mid,mno from public.subscribers where tenant_id=p_tenant_id and site_id=p_site_id and upper(subscriber_no)=req limit 1;
    else
      select id,subscriber_no into mid,mno from public.subscribers where tenant_id=p_tenant_id and site_id=p_site_id and lower(trim(full_name))=lower(f) and phone=ph limit 1;
    end if;

    if mid is not null then
      if v_opening_reading is not null then
        out_failed:=out_failed||jsonb_build_array(jsonb_build_object('sourceRow',n,'fullName',f,'reason','القراءة الافتتاحية مخصصة للمشترك الجديد فقط؛ لا تُستبدل بها قراءة تاريخية.'));
        continue;
      end if;
      if not p_update_existing then
        out_failed:=out_failed||jsonb_build_array(jsonb_build_object('sourceRow',n,'fullName',f,'reason','يوجد مشترك مطابق؛ فعّل خيار تحديث المشتركين الموجودين.'));
        continue;
      end if;
      update public.subscribers set full_name=f,phone=ph,whatsapp_number=wa,address=ad,subscription_type=st,updated_at=now() where id=mid and tenant_id=p_tenant_id and site_id=p_site_id;
      out_updated:=out_updated||jsonb_build_array(jsonb_build_object('id',mid,'sourceRow',n,'fullName',f,'subscriberNo',mno));
      continue;
    end if;

    if cnt+made>=p_quota_limit then
      out_failed:=out_failed||jsonb_build_array(jsonb_build_object('sourceRow',n,'fullName',f,'reason','يتجاوز هذا الصف الحد المتاح للمشتركين في الباقة.'));
      continue;
    end if;

    mno:=format('SUB-%s',lpad(nextval('public.subscriber_global_number_seq')::text,6,'0'));
    insert into public.subscribers(tenant_id,site_id,subscriber_no,full_name,phone,whatsapp_number,address,subscription_type)
    values(p_tenant_id,p_site_id,mno,f,ph,wa,ad,st) returning id into sid;

    if v_opening_reading is not null then
      insert into public.meter_readings(
        tenant_id,subscriber_id,reading_at,reading_value,previous_reading_value,
        consumption_kwh,capture_method,status,entered_by_user_id,reviewed_by_user_id,
        reviewed_at,notes,is_opening_baseline
      ) values(
        p_tenant_id,sid,v_opening_at,v_opening_reading,null,0,'manual',
        case when v_opening_approved then 'approved' else 'pending_review' end,
        p_user_id,case when v_opening_approved then p_user_id else null end,
        case when v_opening_approved then now() else null end,
        'قراءة افتتاحية عند الاستيراد الجماعي',true
      ) returning id into v_baseline_id;
    else
      v_baseline_id := null;
    end if;

    insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
    values(
      p_tenant_id,p_site_id,p_user_id,role_name,'subscriber',sid::text,'bulk_import_create',
      jsonb_build_object(
        'fullName',f,'phone',ph,'subscriberNo',mno,'sourceRow',n,
        'openingReading',v_opening_reading,'openingReadingId',v_baseline_id,
        'openingReadingApproved',v_opening_approved
      )
    );

    made:=made+1;
    out_created:=out_created||jsonb_build_array(jsonb_build_object(
      'id',sid,'sourceRow',n,'fullName',f,'subscriberNo',mno,
      'openingReadingId',v_baseline_id,
      'openingReadingStatus',case when v_opening_reading is null then null when v_opening_approved then 'approved' else 'pending_review' end
    ));
  end loop;

  v_response:=jsonb_build_object('created',out_created,'updated',out_updated,'failed',out_failed);
  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,operation_type,
    entity_type,entity_id,response,request_fingerprint
  ) values(
    p_tenant_id,p_site_id,p_user_id,trim(p_client_operation_id),
    'subscriber_bulk_import','subscriber_bulk_import',p_site_id,v_response,p_request_fingerprint
  );

  return query select out_created,out_updated,out_failed,false;
end;
$function$;

revoke execute on function public.powerhub_bulk_upsert_subscribers(
  bigint,bigint,bigint,jsonb,boolean,integer,text,text
) from public,anon,authenticated;
grant execute on function public.powerhub_bulk_upsert_subscribers(
  bigint,bigint,bigint,jsonb,boolean,integer,text,text
) to service_role;
