-- PowerHub global subscriber reference contract.
-- Format: SUB-000001, SUB-000002, ...
-- The reference is global across PowerHub, independent of tenant/site,
-- immutable for the subscriber lifetime, and allocated from a PostgreSQL sequence.
-- Subscriber lookup still requires a second verifier (phone); the reference alone
-- is never an authentication or disclosure token.

create sequence if not exists public.powerhub_subscriber_no_seq
  as bigint
  minvalue 1
  maxvalue 999999
  start with 1
  increment by 1
  no cycle;

revoke all on sequence public.powerhub_subscriber_no_seq from public, anon, authenticated;
grant usage, select on sequence public.powerhub_subscriber_no_seq to service_role;

-- This deployment has no operational subscriber dataset yet. Normalize any
-- pre-existing test rows deterministically before switching to global uniqueness.
with ranked as (
  select id, row_number() over (order by id) as ordinal
  from public.subscribers
)
update public.subscribers s
set subscriber_no = 'SUB-' || lpad(r.ordinal::text, 6, '0')
from ranked r
where s.id = r.id;

-- The old constraint allowed the same subscriber number on different sites.
-- The official contract is globally unique.
alter table public.subscribers
drop constraint if exists subscribers_site_id_subscriber_no_key;

create unique index if not exists subscribers_subscriber_no_global_uidx
  on public.subscribers(subscriber_no);

-- Every stored reference must follow the official human-readable format.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.subscribers'::regclass
      and conname = 'subscribers_subscriber_no_format_check'
  ) then
    alter table public.subscribers
      add constraint subscribers_subscriber_no_format_check
      check (subscriber_no ~ '^SUB-[0-9]{6}$');
  end if;
end;
$$;

-- Reference numbers are identifiers, not editable business data.
create or replace function public.powerhub_subscriber_reference_immutable()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.subscriber_no is distinct from old.subscriber_no then
    raise exception 'SUBSCRIBER_REFERENCE_IMMUTABLE' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists subscribers_reference_immutable on public.subscribers;
create trigger subscribers_reference_immutable
before update on public.subscribers
for each row
execute function public.powerhub_subscriber_reference_immutable();

-- Align the global sequence with any normalized rows. The sequence is non-cycling
-- and PostgreSQL sequence values are not rolled back, so an allocated value is
-- never reused even when its surrounding transaction fails.
do $$
declare
  v_max bigint;
begin
  select max((substring(subscriber_no from 5))::bigint)
    into v_max
  from public.subscribers
  where subscriber_no ~ '^SUB-[0-9]{6}$';

  if v_max is null then
    perform setval('public.powerhub_subscriber_no_seq', 1, false);
  else
    perform setval('public.powerhub_subscriber_no_seq', v_max, true);
  end if;
end;
$$;

-- The existing RPC keeps its signature for client compatibility, but the
-- caller-supplied subscriber number is deliberately ignored.
create or replace function public.powerhub_create_subscriber(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_subscriber_no text,
  p_full_name text,
  p_phone text,
  p_whatsapp_number text,
  p_address text,
  p_subscription_type text,
  p_client_operation_id uuid,
  p_quota_limit integer
)
returns table (subscriber_id bigint, subscriber_no text, replayed boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_subscriber_id bigint;
  v_subscriber_no text;
  v_response jsonb;
  v_platform_role text;
  v_current_count integer;
  v_sequence bigint;
begin
  if p_client_operation_id is not null then
    select response into v_response
    from public.offline_sync_operations
    where user_id = p_user_id and client_operation_id = p_client_operation_id::text
    limit 1;
    if found then
      if coalesce(v_response->>'id', '') = '' or coalesce(v_response->>'subscriberNo', '') = '' then
        raise exception 'INVALID_SUBSCRIBER_OPERATION_REPLAY' using errcode = 'P0001';
      end if;
      return query select (v_response->>'id')::bigint, v_response->>'subscriberNo', true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(p_tenant_id);

  if not exists (select 1 from public.sites where id = p_site_id and tenant_id = p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  if p_client_operation_id is not null then
    select id, subscriber_no into v_subscriber_id, v_subscriber_no
    from public.subscribers
    where client_operation_id = p_client_operation_id::text
    limit 1;
    if found then
      return query select v_subscriber_id, v_subscriber_no, true;
      return;
    end if;
  end if;

  select count(*)::integer into v_current_count
  from public.subscribers
  where tenant_id = p_tenant_id;
  if v_current_count >= p_quota_limit then
    raise exception 'SUBSCRIBER_QUOTA_REACHED' using errcode = 'P0001';
  end if;

  v_sequence := nextval('public.powerhub_subscriber_no_seq');
  if v_sequence > 999999 then
    raise exception 'SUBSCRIBER_REFERENCE_EXHAUSTED' using errcode = 'P0001';
  end if;
  v_subscriber_no := 'SUB-' || lpad(v_sequence::text, 6, '0');

  insert into public.subscribers (
    tenant_id, site_id, subscriber_no, client_operation_id, full_name, phone,
    whatsapp_number, address, subscription_type
  ) values (
    p_tenant_id, p_site_id, v_subscriber_no, p_client_operation_id::text,
    p_full_name, p_phone, nullif(p_whatsapp_number, ''), nullif(p_address, ''),
    p_subscription_type
  ) returning id into v_subscriber_id;

  select platform_role into v_platform_role from public.users where id = p_user_id;
  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data
  ) values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role, 'subscriber', v_subscriber_id::text, 'create',
    jsonb_build_object(
      'siteId', p_site_id, 'fullName', p_full_name, 'phone', p_phone,
      'whatsappNumber', nullif(p_whatsapp_number, ''), 'address', nullif(p_address, ''),
      'subscriptionType', p_subscription_type, 'subscriberNo', v_subscriber_no,
      'clientOperationId', p_client_operation_id
    )
  );

  if p_client_operation_id is not null then
    insert into public.offline_sync_operations (
      tenant_id, site_id, user_id, client_operation_id, operation_type,
      entity_type, entity_id, response
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

  return query select v_subscriber_id, v_subscriber_no, false;
end;
$$;

revoke execute on function public.powerhub_create_subscriber(bigint, bigint, bigint, text, text, text, text, text, text, uuid, integer) from public, anon, authenticated;
grant execute on function public.powerhub_create_subscriber(bigint, bigint, bigint, text, text, text, text, text, text, uuid, integer) to service_role;

-- Bulk imports also allocate references server-side. Existing subscriber matching
-- remains tenant/site scoped, but newly-created subscribers never accept a caller
-- supplied reference number.
create or replace function public.powerhub_bulk_upsert_subscribers(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_rows jsonb,
  p_update_existing boolean,
  p_quota_limit integer
)
returns table(created jsonb, updated jsonb, failed jsonb)
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
  v_match_no text;
  v_existing_name text;
  v_existing_phone text;
  v_platform_role text;
  v_current_count integer;
  v_created_count integer := 0;
  v_created jsonb := '[]'::jsonb;
  v_updated jsonb := '[]'::jsonb;
  v_failed jsonb := '[]'::jsonb;
  v_match_id bigint;
  v_index integer := 0;
  v_sequence bigint;
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
    v_requested_no := nullif(upper(regexp_replace(trim(coalesce(v_row->>'subscriberNo', '')), '\\s+', '', 'g')), '');
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
      where tenant_id = p_tenant_id
        and site_id = p_site_id
        and subscriber_no = v_requested_no
      limit 1;
    else
      select id, subscriber_no into v_match_id, v_match_no
      from public.subscribers
      where tenant_id = p_tenant_id
        and site_id = p_site_id
        and lower(trim(full_name)) = lower(v_full_name)
        and phone = v_phone
      limit 1;
    end if;

    if v_match_id is not null then
      if not p_update_existing then
        v_failed := v_failed || jsonb_build_array(jsonb_build_object(
          'sourceRow', v_source_row, 'fullName', v_full_name,
          'reason', case when v_requested_no is not null
            then 'الرقم المرجعي يعود لمشترك موجود؛ فعّل خيار تحديث المشتركين المطابقين لتعديل بياناته.'
            else 'يوجد مشترك بالاسم ورقم الجوال نفسيهما في هذا الفرع.' end
        ));
        continue;
      end if;

      select full_name, phone into v_existing_name, v_existing_phone
      from public.subscribers where id = v_match_id;

      update public.subscribers
      set full_name = v_full_name,
          phone = v_phone,
          whatsapp_number = v_whatsapp,
          address = v_address,
          subscription_type = v_subscription_type,
          updated_at = now()
      where id = v_match_id
        and tenant_id = p_tenant_id
        and site_id = p_site_id;

      insert into public.audit_logs (
        tenant_id, site_id, user_id, actor_platform_role, entity_type,
        entity_id, action, before_data, after_data
      ) values (
        p_tenant_id, p_site_id, p_user_id, v_platform_role, 'subscriber',
        v_match_id::text, 'bulk_import_update',
        jsonb_build_object('fullName', v_existing_name, 'phone', v_existing_phone),
        jsonb_build_object('fullName', v_full_name, 'phone', v_phone,
          'subscriberNo', v_match_no, 'sourceRow', v_source_row)
      );

      v_updated := v_updated || jsonb_build_array(jsonb_build_object(
        'id', v_match_id, 'sourceRow', v_source_row, 'fullName', v_full_name,
        'subscriberNo', v_match_no
      ));
      continue;
    end if;

    if v_current_count + v_created_count >= p_quota_limit then
      v_failed := v_failed || jsonb_build_array(jsonb_build_object(
        'sourceRow', v_source_row, 'fullName', v_full_name,
        'reason', 'يتجاوز هذا الصف الحد المتاح للمشتركين في الباقة.'
      ));
      continue;
    end if;

    v_sequence := nextval('public.powerhub_subscriber_no_seq');
    if v_sequence > 999999 then
      raise exception 'SUBSCRIBER_REFERENCE_EXHAUSTED' using errcode = 'P0001';
    end if;
    v_match_no := 'SUB-' || lpad(v_sequence::text, 6, '0');

    insert into public.subscribers (
      tenant_id, site_id, subscriber_no, full_name, phone,
      whatsapp_number, address, subscription_type
    ) values (
      p_tenant_id, p_site_id, v_match_no, v_full_name, v_phone,
      v_whatsapp, v_address, v_subscription_type
    ) returning id into v_subscriber_id;

    insert into public.audit_logs (
      tenant_id, site_id, user_id, actor_platform_role, entity_type,
      entity_id, action, after_data
    ) values (
      p_tenant_id, p_site_id, p_user_id, v_platform_role, 'subscriber',
      v_subscriber_id::text, 'bulk_import_create',
      jsonb_build_object('fullName', v_full_name, 'phone', v_phone,
        'subscriberNo', v_match_no, 'sourceRow', v_source_row)
    );

    v_created_count := v_created_count + 1;
    v_created := v_created || jsonb_build_array(jsonb_build_object(
      'id', v_subscriber_id, 'sourceRow', v_source_row,
      'fullName', v_full_name, 'subscriberNo', v_match_no
    ));
  end loop;

  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role, entity_type,
    entity_id, action, after_data
  ) values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role, 'subscriber_import',
    'bulk-' || gen_random_uuid()::text, 'bulk_import',
    jsonb_build_object(
      'requested', jsonb_array_length(p_rows),
      'created', jsonb_array_length(v_created),
      'updated', jsonb_array_length(v_updated),
      'failed', jsonb_array_length(v_failed),
      'updateExisting', p_update_existing
    )
  );

  return query select v_created, v_updated, v_failed;
end;
$$;

revoke execute on function public.powerhub_bulk_upsert_subscribers(bigint, bigint, bigint, jsonb, boolean, integer) from public, anon, authenticated;
grant execute on function public.powerhub_bulk_upsert_subscribers(bigint, bigint, bigint, jsonb, boolean, integer) to service_role;
