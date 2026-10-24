-- PowerHub Batch A: safe server-side reservation and local claim foundations
-- for offline subscriber and invoice references.
--
-- This migration deliberately does NOT rewrite historical subscriber/invoice values.
-- Subscriber numbering remains global; invoice numbering remains global per year.
-- Grants and claims are private server-side records, never a direct browser API.

-- 1) Consolidate subscriber creation onto the canonical, global sequence contract.
create sequence if not exists public.subscriber_global_number_seq
  as bigint minvalue 1 maxvalue 999999 start with 1 increment by 1 no cycle;

do $subscriber_sequence_reconcile$
declare
  v_high_water bigint := 0;
  v_sequence_value bigint;
  v_sequence_called boolean;
  v_legacy_value bigint;
  v_legacy_called boolean;
begin
  -- Fail closed if existing references cannot be represented by SUB-######.
  if exists (
    select 1
    from public.subscribers
    where subscriber_no !~ '^SUB-[0-9]{6}$'
       or substring(subscriber_no from '^SUB-([0-9]{6})$')::bigint > 999999
  ) then
    raise exception 'SUBSCRIBER_NUMBER_RECONCILIATION_REQUIRED'
      using detail = 'Existing subscriber references were left unchanged; inspect the baseline report before retrying.';
  end if;

  select coalesce(max(substring(subscriber_no from '^SUB-([0-9]{6})$')::bigint), 0)
    into v_high_water
  from public.subscribers;

  select last_value, is_called
    into v_sequence_value, v_sequence_called
  from public.subscriber_global_number_seq;

  if v_sequence_called then
    v_high_water := greatest(v_high_water, v_sequence_value);
  end if;

  -- Some older environments still have the retired allocator. Preserve its
  -- high-water mark rather than risking a previously allocated number again.
  if to_regclass('public.powerhub_subscriber_no_seq') is not null then
    execute 'select last_value, is_called from public.powerhub_subscriber_no_seq'
      into v_legacy_value, v_legacy_called;
    if v_legacy_called then
      v_high_water := greatest(v_high_water, v_legacy_value);
    end if;
  end if;

  if v_high_water > 999999 then
    raise exception 'SUBSCRIBER_NUMBER_SEQUENCE_EXHAUSTED'
      using detail = 'The current sequence or an existing reference exceeds the supported six-digit format.';
  end if;

  alter sequence public.subscriber_global_number_seq maxvalue 999999 no cycle;
  if v_high_water = 0 then
    perform setval('public.subscriber_global_number_seq', 1, false);
  else
    perform setval('public.subscriber_global_number_seq', v_high_water, true);
  end if;
end
$subscriber_sequence_reconcile$;

revoke all on sequence public.subscriber_global_number_seq from public, anon, authenticated;
grant usage, select on sequence public.subscriber_global_number_seq to service_role;

-- Staging has an older overloaded signature accepting a browser-provided number.
-- Remove that route and restore the same canonical signature used by the app.
drop function if exists public.powerhub_create_subscriber(
  bigint, bigint, bigint, text, text, text, text, text, text, uuid, integer
);

create or replace function public.powerhub_create_subscriber(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
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
  v_feature_policy record;
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
  if p_full_name is null or length(trim(p_full_name)) < 2 then
    raise exception 'INVALID_SUBSCRIBER_NAME' using errcode = 'P0001';
  end if;
  if p_phone is null or length(trim(p_phone)) < 5 then
    raise exception 'INVALID_SUBSCRIBER_PHONE' using errcode = 'P0001';
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
  select * into v_feature_policy
  from public.powerhub_resolve_tenant_feature_policy(p_tenant_id, 'subscriber_management');
  if not coalesce(v_feature_policy.eligible, false)
     or not coalesce(v_feature_policy.enabled, false) then
    raise exception 'SUBSCRIBER_FEATURE_DISABLED' using errcode = 'P0001';
  end if;
  if v_feature_policy.effective_limit is not null
     and v_current_count >= v_feature_policy.effective_limit then
    raise exception 'SUBSCRIBER_QUOTA_REACHED' using errcode = 'P0001';
  end if;

  -- The sequence is capped at 999999. It does not cycle, so issued or
  -- transaction-aborted values are never recycled.
  v_subscriber_no := format('SUB-%s', lpad(nextval('public.subscriber_global_number_seq')::text, 6, '0'));

  insert into public.subscribers (
    tenant_id, site_id, subscriber_no, client_operation_id,
    full_name, phone, whatsapp_number, address, subscription_type
  ) values (
    p_tenant_id, p_site_id, v_subscriber_no, p_client_operation_id::text,
    trim(p_full_name), trim(p_phone), nullif(trim(p_whatsapp_number), ''),
    nullif(trim(p_address), ''), p_subscription_type
  ) returning id, subscriber_no into v_subscriber_id, v_subscriber_no;

  select platform_role into v_platform_role from public.users where id = p_user_id;
  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data
  ) values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role, 'subscriber', v_subscriber_id::text, 'create',
    jsonb_build_object(
      'siteId', p_site_id, 'fullName', trim(p_full_name), 'phone', trim(p_phone),
      'whatsappNumber', nullif(trim(p_whatsapp_number), ''),
      'address', nullif(trim(p_address), ''), 'subscriptionType', p_subscription_type,
      'subscriberNo', v_subscriber_no, 'clientOperationId', p_client_operation_id
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
        'id', v_subscriber_id, 'subscriberNo', v_subscriber_no,
        'referenceNotifications', jsonb_build_array()
      )
    );
  end if;

  return query select v_subscriber_id, v_subscriber_no, false;
end;
$$;

revoke all on function public.powerhub_create_subscriber(
  bigint, bigint, bigint, text, text, text, text, text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.powerhub_create_subscriber(
  bigint, bigint, bigint, text, text, text, text, text, uuid, integer
) to service_role;

-- 2) Reconcile the shared yearly invoice allocator without rewriting invoices.
create table if not exists public.powerhub_invoice_sequences (
  invoice_year integer primary key,
  next_sequence bigint not null
);

alter table public.powerhub_invoice_sequences
  alter column next_sequence type bigint using next_sequence::bigint;
alter table public.powerhub_invoice_sequences
  drop constraint if exists powerhub_invoice_sequences_next_sequence_check;
alter table public.powerhub_invoice_sequences
  add constraint powerhub_invoice_sequences_next_sequence_check check (next_sequence > 0);

-- Support the old four-digit and current eight-digit official invoice formats.
-- Custom staging fixtures (for example STG-E2E-*) are deliberately ignored.
with parsed_invoices as (
  select
    (regexp_match(invoice_no, '^INV-([0-9]{4})-([0-9]{4}|[0-9]{8})$'))[1]::integer as invoice_year,
    (regexp_match(invoice_no, '^INV-([0-9]{4})-([0-9]{4}|[0-9]{8})$'))[2]::bigint as sequence_no
  from public.invoices
  where invoice_no ~ '^INV-[0-9]{4}-([0-9]{4}|[0-9]{8})$'
)
insert into public.powerhub_invoice_sequences(invoice_year, next_sequence)
select invoice_year, greatest(max(sequence_no) + 1, 1)
from parsed_invoices
group by invoice_year
on conflict (invoice_year) do update
  set next_sequence = greatest(public.powerhub_invoice_sequences.next_sequence, excluded.next_sequence);

alter table public.powerhub_invoice_sequences enable row level security;
revoke all on table public.powerhub_invoice_sequences from public, anon, authenticated;
grant select, insert, update on table public.powerhub_invoice_sequences to service_role;

-- 3) Private range grants. Values are persisted in PostgreSQL before they are
-- returned to the device. A grant may be shorter than requested only when the
-- global six-digit subscriber namespace is nearly exhausted.
create table if not exists public.powerhub_offline_number_grants (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null default gen_random_uuid(),
  tenant_id bigint not null references public.tenants(id) on delete restrict,
  site_id bigint not null references public.sites(id) on delete restrict,
  user_id bigint not null references public.users(id) on delete restrict,
  device_id uuid not null,
  number_kind text not null check (number_kind in ('subscriber', 'invoice')),
  partition_key text not null,
  reserved_values bigint[] not null,
  issued_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint powerhub_offline_number_grants_request_unique unique (user_id, device_id, number_kind, partition_key, request_id),
  constraint powerhub_offline_number_grants_partition_check check (
    (number_kind = 'subscriber' and partition_key = 'global')
    or
    (number_kind = 'invoice' and partition_key ~ '^[0-9]{4}$')
  ),
  constraint powerhub_offline_number_grants_count_check check (
    cardinality(reserved_values) between 1 and 200
  ),
  constraint powerhub_offline_number_grants_expiry_check check (expires_at > issued_at)
);

create index if not exists powerhub_offline_number_grants_scope_idx
  on public.powerhub_offline_number_grants
    (tenant_id, site_id, user_id, device_id, number_kind, partition_key, expires_at)
  where revoked_at is null;

create table if not exists public.powerhub_offline_number_claims (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references public.powerhub_offline_number_grants(id) on delete restrict,
  tenant_id bigint not null references public.tenants(id) on delete restrict,
  site_id bigint not null references public.sites(id) on delete restrict,
  user_id bigint not null references public.users(id) on delete restrict,
  device_id uuid not null,
  number_kind text not null check (number_kind in ('subscriber', 'invoice')),
  partition_key text not null,
  number_value bigint not null check (number_value > 0),
  client_operation_id text not null check (length(btrim(client_operation_id)) > 0),
  entity_type text not null check (entity_type in ('subscriber', 'invoice')),
  created_at timestamptz not null default clock_timestamp(),
  constraint powerhub_offline_number_claims_partition_check check (
    (number_kind = 'subscriber' and partition_key = 'global' and entity_type = 'subscriber' and number_value <= 999999)
    or
    (number_kind = 'invoice' and partition_key ~ '^[0-9]{4}$' and entity_type = 'invoice')
  ),
  constraint powerhub_offline_number_claims_global_number_unique unique (number_kind, partition_key, number_value),
  constraint powerhub_offline_number_claims_grant_number_unique unique (grant_id, number_value),
  constraint powerhub_offline_number_claims_operation_unique unique (user_id, client_operation_id, entity_type)
);

create index if not exists powerhub_offline_number_claims_scope_idx
  on public.powerhub_offline_number_claims (tenant_id, site_id, user_id, created_at desc);

alter table public.powerhub_offline_number_grants enable row level security;
alter table public.powerhub_offline_number_claims enable row level security;
revoke all on table public.powerhub_offline_number_grants from public, anon, authenticated;
revoke all on table public.powerhub_offline_number_claims from public, anon, authenticated;
grant select, insert, update, delete on table public.powerhub_offline_number_grants to service_role;
grant select, insert, update, delete on table public.powerhub_offline_number_claims to service_role;

comment on table public.powerhub_offline_number_grants is
  'Private server-issued device-scoped offline number grants; reserved values are never recycled.';
comment on table public.powerhub_offline_number_claims is
  'Private idempotent claims of reserved offline subscriber/invoice numbers during server synchronization.';

-- Only a trusted server route (after requireSupabaseSiteRole) may call this RPC.
-- It validates the tenant/site/user envelope again and exposes no direct browser grant.
create or replace function public.powerhub_reserve_offline_number_grant(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_device_id uuid,
  p_request_id uuid,
  p_number_kind text,
  p_partition_key text,
  p_count integer default 50,
  p_ttl_minutes integer default 43200
)
returns table (
  grant_id uuid,
  number_kind text,
  partition_key text,
  reserved_values text[],
  issued_at timestamptz,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_reserved bigint[] := array[]::bigint[];
  v_output_values text[];
  v_number bigint;
  v_start bigint;
  v_year integer;
  v_grant_id uuid;
  v_existing_grant public.powerhub_offline_number_grants%rowtype;
  v_issued_at timestamptz := clock_timestamp();
  v_expires_at timestamptz;
  v_i integer;
begin
  if p_tenant_id is null or p_tenant_id < 1
     or p_site_id is null or p_site_id < 1
     or p_user_id is null or p_user_id < 1
     or p_device_id is null or p_request_id is null then
    raise exception 'OFFLINE_NUMBER_SCOPE_REQUIRED' using errcode = 'P0001';
  end if;
  if p_count is null or p_count < 1 or p_count > 200 then
    raise exception 'OFFLINE_NUMBER_COUNT_INVALID' using errcode = 'P0001';
  end if;
  if p_ttl_minutes is null or p_ttl_minutes < 1 or p_ttl_minutes > 43200 then
    raise exception 'OFFLINE_NUMBER_TTL_INVALID' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id
  ) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.users u where u.id = p_user_id) then
    raise exception 'USER_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  -- Idempotent reservation request: a timeout/retry must return the same grant,
  -- never consume a second block of globally unique numbers.
  select * into v_existing_grant
  from public.powerhub_offline_number_grants g
  where g.user_id = p_user_id
    and g.device_id = p_device_id
    and g.number_kind = p_number_kind
    and g.partition_key = p_partition_key
    and g.request_id = p_request_id;
  if found then
    if v_existing_grant.tenant_id <> p_tenant_id
       or v_existing_grant.site_id <> p_site_id
       or cardinality(v_existing_grant.reserved_values) <> p_count then
      raise exception 'OFFLINE_NUMBER_REQUEST_IDEMPOTENCY_MISMATCH' using errcode = 'P0001';
    end if;
    select array_agg(value::text order by ordinal)
      into v_output_values
    from unnest(v_existing_grant.reserved_values) with ordinality as values_with_ordinal(value, ordinal);
    return query select v_existing_grant.id, v_existing_grant.number_kind,
      v_existing_grant.partition_key, v_output_values, v_existing_grant.issued_at, v_existing_grant.expires_at;
    return;
  end if;

  if p_number_kind = 'subscriber' then
    if p_partition_key is distinct from 'global' then
      raise exception 'OFFLINE_NUMBER_PARTITION_INVALID' using errcode = 'P0001';
    end if;
    for v_i in 1..p_count loop
      begin
        v_number := nextval('public.subscriber_global_number_seq');
      exception when sequence_generator_limit_exceeded then
        if cardinality(v_reserved) = 0 then
          raise exception 'SUBSCRIBER_REFERENCE_EXHAUSTED' using errcode = 'P0001';
        end if;
        exit;
      end;
      v_reserved := array_append(v_reserved, v_number);
    end loop;
  elsif p_number_kind = 'invoice' then
    if p_partition_key !~ '^[0-9]{4}$' then
      raise exception 'OFFLINE_NUMBER_PARTITION_INVALID' using errcode = 'P0001';
    end if;
    v_year := p_partition_key::integer;
    if v_year < 1000 or v_year > 9999 then
      raise exception 'OFFLINE_NUMBER_PARTITION_INVALID' using errcode = 'P0001';
    end if;

    -- The same row lock/high-water mark is used by online invoice issuance.
    -- Upsert reserves N consecutive values atomically without a COUNT()-based allocator.
    insert into public.powerhub_invoice_sequences(invoice_year, next_sequence)
    values (v_year, p_count + 1)
    on conflict (invoice_year) do update
      set next_sequence = public.powerhub_invoice_sequences.next_sequence + p_count
    returning next_sequence - p_count into v_start;

    if v_start is null or v_start < 1 then
      raise exception 'INVOICE_SEQUENCE_INVALID' using errcode = 'P0001';
    end if;
    select array_agg(series.value order by series.value)
      into v_reserved
    from generate_series(v_start, v_start + p_count - 1) as series(value);
  else
    raise exception 'OFFLINE_NUMBER_KIND_INVALID' using errcode = 'P0001';
  end if;

  if cardinality(v_reserved) = 0 then
    raise exception 'OFFLINE_NUMBER_RANGE_EMPTY' using errcode = 'P0001';
  end if;

  v_expires_at := v_issued_at + make_interval(mins => p_ttl_minutes);
  insert into public.powerhub_offline_number_grants (
    request_id, tenant_id, site_id, user_id, device_id, number_kind, partition_key,
    reserved_values, issued_at, expires_at
  ) values (
    p_request_id, p_tenant_id, p_site_id, p_user_id, p_device_id, p_number_kind, p_partition_key,
    v_reserved, v_issued_at, v_expires_at
  ) returning id into v_grant_id;

  select array_agg(value::text order by ordinal)
    into v_output_values
  from unnest(v_reserved) with ordinality as values_with_ordinal(value, ordinal);

  return query select v_grant_id, p_number_kind, p_partition_key,
    v_output_values, v_issued_at, v_expires_at;
end;
$$;

revoke all on function public.powerhub_reserve_offline_number_grant(
  bigint, bigint, bigint, uuid, uuid, text, text, integer, integer
) from public, anon, authenticated;
grant execute on function public.powerhub_reserve_offline_number_grant(
  bigint, bigint, bigint, uuid, uuid, text, text, integer, integer
) to service_role;
alter function public.powerhub_reserve_offline_number_grant(
  bigint, bigint, bigint, uuid, uuid, text, text, integer, integer
) owner to postgres;

-- Claim a reserved value exactly once when its queued operation reaches the server.
-- A repeated identical client operation returns the same claim; a different operation
-- cannot claim that value, even if it belongs to the same user/device.
create or replace function public.powerhub_claim_offline_number(
  p_grant_id uuid,
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_device_id uuid,
  p_number_kind text,
  p_partition_key text,
  p_number_value text,
  p_client_operation_id text,
  p_entity_type text
)
returns table (claim_id uuid, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_grant public.powerhub_offline_number_grants%rowtype;
  v_existing public.powerhub_offline_number_claims%rowtype;
  v_claim_id uuid;
  v_number_value bigint;
begin
  if p_grant_id is null or p_tenant_id is null or p_site_id is null
     or p_user_id is null or p_device_id is null
     or p_number_kind not in ('subscriber', 'invoice')
     or p_partition_key is null
     or p_client_operation_id is null or length(btrim(p_client_operation_id)) = 0
     or p_entity_type not in ('subscriber', 'invoice') then
    raise exception 'OFFLINE_NUMBER_CLAIM_INPUT_INVALID' using errcode = 'P0001';
  end if;
  if p_number_value is null or length(p_number_value) > 19
     or p_number_value !~ '^[1-9][0-9]*$' then
    raise exception 'OFFLINE_NUMBER_VALUE_INVALID' using errcode = 'P0001';
  end if;
  begin
    v_number_value := p_number_value::bigint;
  exception when numeric_value_out_of_range then
    raise exception 'OFFLINE_NUMBER_VALUE_INVALID' using errcode = 'P0001';
  end;

  select * into v_existing
  from public.powerhub_offline_number_claims c
  where c.user_id = p_user_id
    and c.client_operation_id = p_client_operation_id
    and c.entity_type = p_entity_type;
  if found then
    if v_existing.grant_id <> p_grant_id
       or v_existing.tenant_id <> p_tenant_id
       or v_existing.site_id <> p_site_id
       or v_existing.device_id <> p_device_id
       or v_existing.number_kind <> p_number_kind
       or v_existing.partition_key <> p_partition_key
       or v_existing.number_value <> v_number_value then
      raise exception 'OFFLINE_NUMBER_IDEMPOTENCY_MISMATCH' using errcode = 'P0001';
    end if;
    return query select v_existing.id, true;
    return;
  end if;

  select * into v_grant
  from public.powerhub_offline_number_grants g
  where g.id = p_grant_id
    and g.tenant_id = p_tenant_id
    and g.site_id = p_site_id
    and g.user_id = p_user_id
    and g.device_id = p_device_id
    and g.number_kind = p_number_kind
    and g.partition_key = p_partition_key
    and g.revoked_at is null
    and g.expires_at > clock_timestamp()
  for update;
  if not found then
    raise exception 'OFFLINE_NUMBER_GRANT_INVALID_OR_EXPIRED' using errcode = 'P0001';
  end if;
  if not (v_number_value = any(v_grant.reserved_values)) then
    raise exception 'OFFLINE_NUMBER_NOT_IN_GRANT' using errcode = 'P0001';
  end if;
  if p_number_kind = 'subscriber' and (p_entity_type <> 'subscriber' or v_number_value > 999999) then
    raise exception 'OFFLINE_NUMBER_KIND_MISMATCH' using errcode = 'P0001';
  end if;
  if p_number_kind = 'invoice' and p_entity_type <> 'invoice' then
    raise exception 'OFFLINE_NUMBER_KIND_MISMATCH' using errcode = 'P0001';
  end if;

  begin
    insert into public.powerhub_offline_number_claims (
      grant_id, tenant_id, site_id, user_id, device_id, number_kind,
      partition_key, number_value, client_operation_id, entity_type
    ) values (
      p_grant_id, p_tenant_id, p_site_id, p_user_id, p_device_id, p_number_kind,
      p_partition_key, v_number_value, p_client_operation_id, p_entity_type
    ) returning id into v_claim_id;
  exception when unique_violation then
    select * into v_existing
    from public.powerhub_offline_number_claims c
    where c.user_id = p_user_id
      and c.client_operation_id = p_client_operation_id
      and c.entity_type = p_entity_type;
    if found then
      if v_existing.grant_id <> p_grant_id
         or v_existing.tenant_id <> p_tenant_id
         or v_existing.site_id <> p_site_id
         or v_existing.device_id <> p_device_id
         or v_existing.number_kind <> p_number_kind
         or v_existing.partition_key <> p_partition_key
         or v_existing.number_value <> v_number_value then
        raise exception 'OFFLINE_NUMBER_IDEMPOTENCY_MISMATCH' using errcode = 'P0001';
      end if;
      return query select v_existing.id, true;
      return;
    end if;
    raise exception 'OFFLINE_NUMBER_ALREADY_CLAIMED' using errcode = 'P0001';
  end;

  return query select v_claim_id, false;
end;
$$;

revoke all on function public.powerhub_claim_offline_number(
  uuid, bigint, bigint, bigint, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.powerhub_claim_offline_number(
  uuid, bigint, bigint, bigint, uuid, text, text, text, text, text
) to service_role;
alter function public.powerhub_claim_offline_number(
  uuid, bigint, bigint, bigint, uuid, text, text, text, text, text
) owner to postgres;

-- Explicitly preserve the service-role-only API contract on internal objects.
revoke all on table public.powerhub_offline_number_grants from public, anon, authenticated;
revoke all on table public.powerhub_offline_number_claims from public, anon, authenticated;
grant select, insert, update, delete on table public.powerhub_offline_number_grants to service_role;
grant select, insert, update, delete on table public.powerhub_offline_number_claims to service_role;
