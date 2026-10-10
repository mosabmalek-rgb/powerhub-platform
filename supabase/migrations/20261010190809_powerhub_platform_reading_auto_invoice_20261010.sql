-- PowerHub: approve opening baselines on authorized subscriber writes and atomically invoice platform readings.
-- The caller is separately guarded by the platform's manageSubscribers / recordReadings / approveReadings / issueInvoices capabilities.
-- Opening baselines remain non-billable; the invoice trigger still blocks billing them.

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
as $function$
declare
  v_subscriber_id bigint;
  v_subscriber_no text;
  v_reading_id bigint;
  v_response jsonb;
  v_platform_role text;
  v_current_count integer;
  v_effective_limit integer;
  v_feature_policy record;
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
        (v_response->>'openingReadingId')::bigint,
        v_response->>'openingReadingStatus',
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

  select * into v_feature_policy
  from public.powerhub_resolve_tenant_feature_policy(p_tenant_id, 'subscriber_management');

  if not coalesce(v_feature_policy.eligible, false)
     or not coalesce(v_feature_policy.enabled, false) then
    raise exception 'SUBSCRIBER_FEATURE_DISABLED' using errcode = 'P0001';
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
  end if;select count(*)::integer into v_current_count
  from public.subscribers where tenant_id = p_tenant_id;
  v_effective_limit := v_feature_policy.effective_limit;
  if v_effective_limit is not null and v_current_count >= v_effective_limit then
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
  returning id into v_subscriber_id;

  if p_opening_reading is not null then
    insert into public.meter_readings (
      tenant_id, subscriber_id, client_operation_id, reading_at, reading_value,
      previous_reading_value, consumption_kwh, capture_method,
      image_key, image_hash, status, entered_by_user_id,
      reviewed_by_user_id, reviewed_at, notes, is_opening_baseline
    ) values (
      p_tenant_id, v_subscriber_id, p_client_operation_id::text,
      coalesce(p_opening_reading_at, now()),
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
        'openingReadingId', v_reading_id,
        'openingReadingStatus', case when p_opening_reading is null then null when p_opening_reading_approved then 'approved' else 'pending_review' end,
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
      select response into v_response
      from public.offline_sync_operations
      where user_id = p_user_id
        and client_operation_id = p_client_operation_id::text
      limit 1;
      return query select
        v_subscriber_id,
        v_subscriber_no,
        (v_response->>'openingReadingId')::bigint,
        v_response->>'openingReadingStatus',
        true;
      return;
    end if;
  end if;
  raise;
end;
$function$;

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
  v_feature_policy record;
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

  select * into v_feature_policy
  from public.powerhub_resolve_tenant_feature_policy(p_tenant_id, 'subscriber_management');

  if not coalesce(v_feature_policy.eligible, false)
     or not coalesce(v_feature_policy.enabled, false) then
    raise exception 'SUBSCRIBER_FEATURE_DISABLED';
  end if;

  select count(*)::int into cnt from public.subscribers where tenant_id=p_tenant_id;
  select platform_role into role_name from public.users where id=p_user_id;for r in select value from jsonb_array_elements(p_rows) loop
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
    if v_opening_reading is null and (v_opening_approved or nullif(r->>'openingReadingAt','') is not null) then
      out_failed:=out_failed||jsonb_build_array(jsonb_build_object('sourceRow',n,'fullName',f,'reason','أدخل القراءة الافتتاحية قبل اعتمادها أو تحديد تاريخها.'));
      continue;
    end if;if length(f)<2 then out_failed:=out_failed||jsonb_build_array(jsonb_build_object('sourceRow',n,'fullName',f,'reason','الاسم الكامل قصير جداً.')); continue; end if;
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

    if v_feature_policy.effective_limit is not null and cnt+made>=v_feature_policy.effective_limit then
      out_failed:=out_failed||jsonb_build_array(jsonb_build_object('sourceRow',n,'fullName',f,'reason','يتجاوز هذا الصف الحد المتاح للمشتركين في الباقة.'));
      continue;
    end if;

    mno:=format('SUB-%s',lpad(nextval('public.subscriber_global_number_seq')::text,6,'0'));
    insert into public.subscribers(tenant_id,site_id,subscriber_no,full_name,phone,whatsapp_number,address,subscription_type)
    values(p_tenant_id,p_site_id,mno,f,ph,wa,ad,st) returning id into sid;

    if v_opening_reading is not null then
      insert into public.meter_readings(
        tenant_id,subscriber_id,client_operation_id,reading_at,reading_value,previous_reading_value,
        consumption_kwh,capture_method,status,entered_by_user_id,reviewed_by_user_id,
        reviewed_at,notes,is_opening_baseline
      ) values(
        p_tenant_id,sid,format('%s:opening:%s',trim(p_client_operation_id),n),v_opening_at,v_opening_reading,null,0,'manual',
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

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  ) values(
    p_tenant_id,p_site_id,p_user_id,role_name,'subscriber_import',
    'bulk-'||gen_random_uuid()::text,'bulk_import',
    jsonb_build_object(
      'requested',jsonb_array_length(p_rows),
      'created',jsonb_array_length(out_created),
      'updated',jsonb_array_length(out_updated),
      'failed',jsonb_array_length(out_failed),
      'updateExisting',p_update_existing,
      'openingReadings',true
    )
  );

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

revoke execute on function public.powerhub_create_subscriber_with_opening_reading(bigint,bigint,bigint,text,text,text,text,text,uuid,integer,numeric,timestamptz,text,text,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_create_subscriber_with_opening_reading(bigint,bigint,bigint,text,text,text,text,text,uuid,integer,numeric,timestamptz,text,text,boolean) to service_role;

revoke execute on function public.powerhub_bulk_upsert_subscribers(bigint,bigint,bigint,jsonb,boolean,integer,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_bulk_upsert_subscribers(bigint,bigint,bigint,jsonb,boolean,integer,text,text) to service_role;

revoke execute on function public.powerhub_create_reading_and_issue_invoice(bigint,bigint,bigint,bigint,uuid,timestamptz,numeric,text,text,text,text,boolean,boolean,boolean,timestamptz,text) from public,anon,authenticated;
grant execute on function public.powerhub_create_reading_and_issue_invoice(bigint,bigint,bigint,bigint,uuid,timestamptz,numeric,text,text,text,text,boolean,boolean,boolean,timestamptz,text) to service_role;

