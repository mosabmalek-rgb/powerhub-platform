create or replace function public.powerhub_bulk_upsert_subscribers(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_rows jsonb,
  p_update_existing boolean,
  p_quota_limit integer
)
returns table (created jsonb, updated jsonb, failed jsonb)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_row jsonb;
  v_source_row integer;
  v_full_name text;
  v_phone text;
  v_whatsapp text;
  v_address text;
  v_subscription_type text;
  v_requested_no text;
  v_subscriber_id bigint;
  v_existing_no text;
  v_existing_name text;
  v_existing_phone text;
  v_platform_role text;
  v_current_count integer;
  v_created_count integer := 0;
  v_created jsonb := '[]'::jsonb;
  v_updated jsonb := '[]'::jsonb;
  v_failed jsonb := '[]'::jsonb;
  v_match_id bigint;
  v_match_no text;
  v_index integer := 0;
begin
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'INVALID_BULK_ROWS' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 300 then
    raise exception 'INVALID_BULK_ROWS_COUNT' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(p_tenant_id);

  if not exists (select 1 from public.sites where id = p_site_id and tenant_id = p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  select count(*)::integer into v_current_count
  from public.subscribers
  where tenant_id = p_tenant_id;

  select platform_role into v_platform_role from public.users where id = p_user_id;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_index := v_index + 1;
    v_source_row := coalesce(nullif(v_row->>'sourceRow', '')::integer, v_index + 1);
    v_full_name := trim(coalesce(v_row->>'fullName', ''));
    v_phone := trim(coalesce(v_row->>'phone', ''));
    v_whatsapp := nullif(trim(coalesce(v_row->>'whatsappNumber', '')), '');
    v_address := nullif(trim(coalesce(v_row->>'address', '')), '');
    v_subscription_type := lower(trim(coalesce(v_row->>'subscriptionType', 'residential')));
    v_requested_no := nullif(upper(regexp_replace(trim(coalesce(v_row->>'subscriberNo', '')), '\s+', '', 'g')), '');
    v_match_id := null;
    v_match_no := null;

    if length(v_full_name) < 2 then
      v_failed := v_failed || jsonb_build_array(jsonb_build_object('sourceRow', v_source_row, 'fullName', v_full_name, 'reason', 'الاسم الكامل قصير جداً.'));
      continue;
    end if;
    if length(v_phone) < 5 then
      v_failed := v_failed || jsonb_build_array(jsonb_build_object('sourceRow', v_source_row, 'fullName', v_full_name, 'reason', 'رقم الجوال غير صالح.'));
      continue;
    end if;
    if v_subscription_type not in ('residential', 'commercial') then
      v_failed := v_failed || jsonb_build_array(jsonb_build_object('sourceRow', v_source_row, 'fullName', v_full_name, 'reason', 'نوع الاشتراك غير صالح.'));
      continue;
    end if;

    if v_requested_no is not null then
      select id, subscriber_no into v_match_id, v_match_no
      from public.subscribers
      where tenant_id = p_tenant_id and site_id = p_site_id and upper(regexp_replace(subscriber_no, '\s+', '', 'g')) = v_requested_no
      limit 1;
      if v_match_id is null then
        v_match_no := v_requested_no;
      end if;
    else
      select id, subscriber_no into v_match_id, v_match_no
      from public.subscribers
      where tenant_id = p_tenant_id and site_id = p_site_id and lower(trim(full_name)) = lower(v_full_name) and phone = v_phone
      limit 1;
    end if;

    if v_match_id is not null then
      if not p_update_existing then
        v_failed := v_failed || jsonb_build_array(jsonb_build_object('sourceRow', v_source_row, 'fullName', v_full_name, 'reason', case when v_requested_no is not null then 'الرقم المرجعي يعود لمشترك موجود؛ فعّل خيار تحديث المشتركين المطابقين لتعديل بياناته.' else 'يوجد مشترك بالاسم ورقم الجوال نفسيهما في هذا الفرع.' end));
        continue;
      end if;

      select full_name, phone into v_existing_name, v_existing_phone from public.subscribers where id = v_match_id;
      update public.subscribers
      set full_name = v_full_name,
          phone = v_phone,
          whatsapp_number = v_whatsapp,
          address = v_address,
          subscription_type = v_subscription_type,
          updated_at = now()
      where id = v_match_id and tenant_id = p_tenant_id and site_id = p_site_id;

      insert into public.audit_logs (tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, before_data, after_data)
      values (p_tenant_id, p_site_id, p_user_id, v_platform_role, 'subscriber', v_match_id::text, 'bulk_import_update', jsonb_build_object('fullName', v_existing_name, 'phone', v_existing_phone), jsonb_build_object('fullName', v_full_name, 'phone', v_phone, 'subscriberNo', v_match_no, 'sourceRow', v_source_row));

      v_updated := v_updated || jsonb_build_array(jsonb_build_object('id', v_match_id, 'sourceRow', v_source_row, 'fullName', v_full_name, 'subscriberNo', v_match_no));
      continue;
    end if;

    if v_current_count + v_created_count >= p_quota_limit then
      v_failed := v_failed || jsonb_build_array(jsonb_build_object('sourceRow', v_source_row, 'fullName', v_full_name, 'reason', 'يتجاوز هذا الصف الحد المتاح للمشتركين في الباقة.'));
      continue;
    end if;
    if v_requested_no is null then
      v_requested_no := 'SUB-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
    end if;

    insert into public.subscribers (tenant_id, site_id, subscriber_no, full_name, phone, whatsapp_number, address, subscription_type)
    values (p_tenant_id, p_site_id, v_requested_no, v_full_name, v_phone, v_whatsapp, v_address, v_subscription_type)
    returning id, subscriber_no into v_subscriber_id, v_match_no;

    insert into public.audit_logs (tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data)
    values (p_tenant_id, p_site_id, p_user_id, v_platform_role, 'subscriber', v_subscriber_id::text, 'bulk_import_create', jsonb_build_object('fullName', v_full_name, 'phone', v_phone, 'subscriberNo', v_match_no, 'sourceRow', v_source_row));

    v_created_count := v_created_count + 1;
    v_created := v_created || jsonb_build_array(jsonb_build_object('id', v_subscriber_id, 'sourceRow', v_source_row, 'fullName', v_full_name, 'subscriberNo', v_match_no));
  end loop;

  insert into public.audit_logs (tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data)
  values (p_tenant_id, p_site_id, p_user_id, v_platform_role, 'subscriber_import', 'bulk-' || gen_random_uuid()::text, 'bulk_import', jsonb_build_object('requested', jsonb_array_length(p_rows), 'created', jsonb_array_length(v_created), 'updated', jsonb_array_length(v_updated), 'failed', jsonb_array_length(v_failed), 'updateExisting', p_update_existing));

  return query select v_created, v_updated, v_failed;
end;
$$;

revoke execute on function public.powerhub_bulk_upsert_subscribers(bigint, bigint, bigint, jsonb, boolean, integer) from public, anon, authenticated;
grant execute on function public.powerhub_bulk_upsert_subscribers(bigint, bigint, bigint, jsonb, boolean, integer) to service_role;
