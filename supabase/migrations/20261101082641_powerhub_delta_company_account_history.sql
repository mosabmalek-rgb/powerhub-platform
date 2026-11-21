-- Company-account Delta feed. Balances are full-ledger server projections; cached values are display snapshots only.
-- Expense history Delta feed. Financial writes remain server-authoritative and atomic.
alter table public.powerhub_sync_scope_state drop constraint if exists powerhub_sync_scope_state_entity_type_check;
alter table public.powerhub_sync_scope_state add constraint powerhub_sync_scope_state_entity_type_check check (entity_type in ('sites','subscribers','generators','readings','tariffs','invoices','payments','expenses','company_accounts','company_accounts_all'));
alter table public.powerhub_sync_changes drop constraint if exists powerhub_sync_changes_entity_type_check;
alter table public.powerhub_sync_changes add constraint powerhub_sync_changes_entity_type_check check (entity_type in ('sites','subscribers','generators','readings','tariffs','invoices','payments','expenses','company_accounts','company_accounts_all'));

create or replace function public.powerhub_append_sync_change(
  p_tenant_id bigint,
  p_site_id bigint,
  p_entity_type text,
  p_entity_id text,
  p_change_type text,
  p_row_data jsonb
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_cursor bigint;
  v_cutoff bigint;
begin
  if p_tenant_id is null or p_tenant_id < 1
     or p_site_id is null or p_site_id < 1
     or p_entity_type is null
     or p_entity_type not in ('sites', 'subscribers', 'generators', 'readings', 'tariffs', 'invoices', 'payments', 'expenses', 'company_accounts', 'company_accounts_all')
     or p_entity_id is null or length(p_entity_id) < 1 or length(p_entity_id) > 100
     or p_change_type is null
     or p_change_type not in ('upsert', 'delete')
     or (p_change_type = 'upsert' and p_row_data is null)
     or (p_change_type = 'delete' and p_row_data is not null) then
    raise exception 'POWERHUB_SYNC_CHANGE_INVALID' using errcode = 'P0001';
  end if;

  insert into public.powerhub_sync_scope_state (
    tenant_id, site_id, entity_type, last_cursor, retained_from_cursor, updated_at
  ) values (
    p_tenant_id, p_site_id, p_entity_type, 1, 0, clock_timestamp()
  )
  on conflict (tenant_id, site_id, entity_type)
  do update set
    last_cursor = public.powerhub_sync_scope_state.last_cursor + 1,
    updated_at = clock_timestamp()
  returning last_cursor into v_cursor;

  insert into public.powerhub_sync_changes (
    tenant_id, site_id, entity_type, cursor, entity_id, change_type, row_data, changed_at
  ) values (
    p_tenant_id, p_site_id, p_entity_type, v_cursor, p_entity_id,
    p_change_type, p_row_data, clock_timestamp()
  );

  -- Retain the newest 10,000 positions for each tenant/site/entity scope.
  if v_cursor > 10000 and mod(v_cursor, 500) = 0 then
    v_cutoff := v_cursor - 10000;
    delete from public.powerhub_sync_changes c
    where c.tenant_id = p_tenant_id
      and c.site_id = p_site_id
      and c.entity_type = p_entity_type
      and c.cursor <= v_cutoff;

    update public.powerhub_sync_scope_state s
    set retained_from_cursor = greatest(s.retained_from_cursor, v_cutoff),
        updated_at = clock_timestamp()
    where s.tenant_id = p_tenant_id
      and s.site_id = p_site_id
      and s.entity_type = p_entity_type;
  end if;

  return v_cursor;
end;
$$;
alter function public.powerhub_append_sync_change(bigint, bigint, text, text, text, jsonb) owner to postgres;
revoke all on function public.powerhub_append_sync_change(bigint, bigint, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.powerhub_append_sync_change(bigint, bigint, text, text, text, jsonb) to service_role;




create or replace function public.powerhub_delta_sync_project_row(p_entity_type text, p_row jsonb)
returns jsonb
language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select case p_entity_type
    when 'sites' then jsonb_build_object(
      'id',p_row->'id','tenant_id',p_row->'tenant_id','tenant_name',p_row->'tenant_name',
      'name',p_row->'name','code',p_row->'code','city',p_row->'city','address',p_row->'address',
      'status',p_row->'status','anomaly_alert_percent',p_row->'anomaly_alert_percent',
      'invoice_due_days',p_row->'invoice_due_days','invoice_due_hours',p_row->'invoice_due_hours',
      'created_at',p_row->'created_at'
    )
    when 'subscribers' then jsonb_build_object(
      'id',p_row->'id','tenant_id',p_row->'tenant_id','site_id',p_row->'site_id',
      'subscriber_no',p_row->'subscriber_no','client_operation_id',p_row->'client_operation_id',
      'full_name',p_row->'full_name','phone',p_row->'phone','whatsapp_number',p_row->'whatsapp_number',
      'address',p_row->'address','subscription_type',p_row->'subscription_type',
      'service_status',p_row->'service_status','created_at',p_row->'created_at','updated_at',p_row->'updated_at'
    )
    when 'generators' then jsonb_build_object(
      'id',p_row->'id','tenant_id',p_row->'tenant_id','site_id',p_row->'site_id',
      'code',p_row->'code','name',p_row->'name','serial_number',p_row->'serial_number',
      'rated_capacity_kw',p_row->'rated_capacity_kw','fuel_type',p_row->'fuel_type',
      'fuel_level_liters',p_row->'fuel_level_liters','operating_hours',p_row->'operating_hours',
      'status',p_row->'status','last_maintenance_at',p_row->'last_maintenance_at',
      'created_at',p_row->'created_at','updated_at',p_row->'updated_at'
    )
    when 'readings' then jsonb_build_object(
      'id',p_row->'id','tenant_id',p_row->'tenant_id','site_id',p_row->'site_id','subscriber_id',p_row->'subscriber_id',
      'client_operation_id',p_row->'client_operation_id','reading_at',p_row->'reading_at',
      'reading_value',p_row->'reading_value','previous_reading_value',p_row->'previous_reading_value',
      'consumption_kwh',p_row->'consumption_kwh','capture_method',p_row->'capture_method',
      'image_key',p_row->'image_key','image_hash',p_row->'image_hash','status',p_row->'status',
      'entered_by_user_id',p_row->'entered_by_user_id','reviewed_by_user_id',p_row->'reviewed_by_user_id',
      'reviewed_at',p_row->'reviewed_at','notes',p_row->'notes','version_no',p_row->'version_no',
      'created_at',p_row->'created_at','updated_at',p_row->'updated_at'
    )
    when 'invoices' then jsonb_build_object(
      'id',p_row->'id','tenant_id',p_row->'tenant_id','site_id',p_row->'site_id',
      'subscriber_id',p_row->'subscriber_id','reading_id',p_row->'reading_id','tariff_id',p_row->'tariff_id',
      'invoice_no',p_row->'invoice_no','client_operation_id',p_row->'client_operation_id',
      'billing_period',p_row->'billing_period','issue_date',p_row->'issue_date','due_date',p_row->'due_date',
      'previous_reading',p_row->'previous_reading','current_reading',p_row->'current_reading',
      'consumption_kwh',p_row->'consumption_kwh','price_per_kwh',p_row->'price_per_kwh',
      'fixed_fee',p_row->'fixed_fee','tax_amount',p_row->'tax_amount','discount_amount',p_row->'discount_amount',
      'total_amount',p_row->'total_amount','paid_amount',p_row->'paid_amount','balance_due',p_row->'balance_due',
      'status',p_row->'status','cycle_key',p_row->'cycle_key','cycle_start_at',p_row->'cycle_start_at',
      'cycle_end_at',p_row->'cycle_end_at','created_by_user_id',p_row->'created_by_user_id',
      'created_at',p_row->'created_at','updated_at',p_row->'updated_at'
    )
    when 'payments' then jsonb_build_object(
      'id',p_row->'id','tenant_id',p_row->'tenant_id','site_id',p_row->'site_id',
      'subscriber_id',p_row->'subscriber_id','invoice_id',p_row->'invoice_id',
      'payment_no',p_row->'payment_no','client_operation_id',p_row->'client_operation_id',
      'amount',p_row->'amount','payment_method',p_row->'payment_method',
      'transfer_from_account',p_row->'transfer_from_account','transfer_from_type',p_row->'transfer_from_type',
      'transfer_to_account',p_row->'transfer_to_account','transfer_to_type',p_row->'transfer_to_type',
      'reference_no',p_row->'reference_no','status',p_row->'status',
      'has_receipt_image',to_jsonb(coalesce(p_row->>'receipt_image_key','') <> ''),
      'collected_by_user_id',p_row->'collected_by_user_id',
      'collector_session_id',p_row->'collector_session_id',
      'paid_at',p_row->'paid_at','created_at',p_row->'created_at'
    )
    when 'expenses' then jsonb_build_object(
      'id',p_row->'id','tenant_id',p_row->'tenant_id','site_id',p_row->'site_id',
      'generator_id',p_row->'generator_id','company_account_id',p_row->'company_account_id',
      'category',p_row->'category','description',p_row->'description','amount',p_row->'amount',
      'occurred_at',p_row->'occurred_at','reference_no',p_row->'reference_no',
      'created_by_user_id',p_row->'created_by_user_id','created_at',p_row->'created_at'
    )
    when 'tariffs' then jsonb_build_object(
      'id',p_row->'id','tenant_id',p_row->'tenant_id','site_id',p_row->'site_id',
      'name',p_row->'name','code',p_row->'code','price_per_kwh',p_row->'price_per_kwh',
      'fixed_fee',p_row->'fixed_fee','tax_rate',p_row->'tax_rate','is_active',p_row->'is_active',
      'effective_from',p_row->'effective_from','created_at',p_row->'created_at'
    )
    else null
  end
$$;
alter function public.powerhub_delta_sync_project_row(text,jsonb) owner to postgres;
revoke all on function public.powerhub_delta_sync_project_row(text,jsonb) from public,anon,authenticated;
grant execute on function public.powerhub_delta_sync_project_row(text,jsonb) to service_role;


-- Joined page projection: scoped payment + subscriber + invoice label; omit receipt secrets.


-- Explicit safe projection for company accounts. The balance includes every ledger
-- transaction; the embedded transaction details use the same tenant-wide newest-1,000
-- window as listSupabaseCompanyAccounts.
create or replace function public.powerhub_delta_sync_project_company_account(
  p_tenant_id bigint, p_site_id bigint, p_account_id bigint
) returns jsonb
language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'id', ca.id,
    'tenant_id', ca.tenant_id,
    -- Synthetic cursor scope only; company_accounts itself has no site_id column.
    'site_id', p_site_id,
    'name', ca.name,
    'account_type', ca.account_type,
    'phone_number', ca.phone_number,
    'color', ca.color,
    'opening_balance', ca.opening_balance::text,
    'is_active', ca.is_active,
    'allow_payment_documentation', coalesce(ca.allow_payment_documentation, false),
    'created_at', ca.created_at,
    'updated_at', ca.updated_at,
    'linked_sites', coalesce((
      select jsonb_agg(jsonb_build_object(
        'account_id', link.account_id,
        'site_id', link.site_id,
        'site_name', site_row.name
      ) order by link.site_id)
      from public.company_account_sites link
      join public.sites site_row
        on site_row.id = link.site_id and site_row.tenant_id = link.tenant_id
      where link.tenant_id = ca.tenant_id and link.account_id = ca.id
    ), '[]'::jsonb),
    'balance', ca.opening_balance + coalesce((
      select sum(case when tx.transaction_type in ('deposit','transfer_in','collection')
        then tx.amount else -tx.amount end)
      from public.account_transactions tx
      where tx.tenant_id = ca.tenant_id and tx.account_id = ca.id
    ), 0),
    'transactions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', bounded.id,
        'tenant_id', bounded.tenant_id,
        'account_id', bounded.account_id,
        'transaction_type', bounded.transaction_type,
        'amount', bounded.amount::text,
        'description', bounded.description,
        'reference_no', bounded.reference_no,
        'related_payment_id', bounded.related_payment_id,
        'related_account_id', bounded.related_account_id,
        'created_by_user_id', bounded.created_by_user_id,
        'occurred_at', bounded.occurred_at,
        'created_at', bounded.created_at
      ) order by bounded.occurred_at desc, bounded.id desc)
      from (
        select tx.*
        from public.account_transactions tx
        where tx.tenant_id = ca.tenant_id
        order by tx.occurred_at desc, tx.id desc
        limit 1000
      ) bounded
      where bounded.account_id = ca.id
    ), '[]'::jsonb)
  )
  from public.company_accounts ca
  where ca.tenant_id = p_tenant_id and ca.id = p_account_id and ca.is_active = true;
$$;
alter function public.powerhub_delta_sync_project_company_account(bigint,bigint,bigint) owner to postgres;
revoke all on function public.powerhub_delta_sync_project_company_account(bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_delta_sync_project_company_account(bigint,bigint,bigint) to service_role;

create or replace function public.powerhub_get_sync_snapshot(
  p_tenant_id bigint, p_site_id bigint, p_entity_type text
) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_cursor bigint := 0; v_retained bigint := 0; v_rows jsonb := '[]'::jsonb;
begin
  if p_tenant_id is null or p_tenant_id < 1 or p_site_id is null or p_site_id < 1 then
    raise exception 'POWERHUB_SYNC_SCOPE_REQUIRED' using errcode = 'P0001';
  end if;
  if p_entity_type not in ('sites','subscribers','generators','readings','tariffs','invoices','payments','expenses','company_accounts','company_accounts_all') then
    raise exception 'POWERHUB_SYNC_ENTITY_UNSUPPORTED' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;
  select last_cursor, retained_from_cursor into v_cursor, v_retained
    from public.powerhub_sync_scope_state
    where tenant_id=p_tenant_id and site_id=p_site_id and entity_type=p_entity_type;
  if not found then v_cursor := 0; v_retained := 0; end if;
  case p_entity_type
    when 'sites' then
      select coalesce(jsonb_agg(
        public.powerhub_delta_sync_project_row('sites',
          to_jsonb(s) || jsonb_build_object('tenant_name', t.name))
        order by s.created_at desc, s.id desc), '[]'::jsonb)
        into v_rows
      from public.sites s
      join public.tenants t on t.id = s.tenant_id
      where s.tenant_id = p_tenant_id and s.id = p_site_id;
    when 'subscribers' then
      select coalesce(jsonb_agg(public.powerhub_delta_sync_project_row('subscribers',to_jsonb(s)) order by s.created_at desc,s.id desc),'[]'::jsonb)
        into v_rows from public.subscribers s
        where s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.archived_at is null;
    when 'generators' then
      select coalesce(jsonb_agg(public.powerhub_delta_sync_project_row('generators',to_jsonb(g)) order by g.created_at desc,g.id desc),'[]'::jsonb)
        into v_rows from public.generators g
        where g.tenant_id=p_tenant_id and g.site_id=p_site_id;
    when 'readings' then
      select coalesce(jsonb_agg(jsonb_build_object('reading',public.powerhub_delta_sync_project_row('readings',to_jsonb(r) || jsonb_build_object('site_id',s.site_id)),'subscriber',public.powerhub_delta_sync_project_row('subscribers',to_jsonb(s)))
        order by r.reading_at desc,r.id desc),'[]'::jsonb)
        into v_rows from public.meter_readings r
        join public.subscribers s on s.id=r.subscriber_id and s.tenant_id=r.tenant_id
        where r.tenant_id=p_tenant_id and s.site_id=p_site_id;
    when 'invoices' then
      select coalesce(jsonb_agg(public.powerhub_delta_sync_project_row('invoices',to_jsonb(i))
        order by i.issue_date desc,i.id desc),'[]'::jsonb)
        into v_rows from public.invoices i
        where i.tenant_id=p_tenant_id and i.site_id=p_site_id;
    when 'expenses' then
      select coalesce(jsonb_agg(public.powerhub_delta_sync_project_row('expenses',to_jsonb(e)) order by e.occurred_at desc,e.id desc),'[]'::jsonb)
        into v_rows from public.expenses e where e.tenant_id=p_tenant_id and e.site_id=p_site_id;
    when 'payments' then
      select coalesce(jsonb_agg(public.powerhub_delta_sync_project_payment(p_tenant_id,p_site_id,p.id)
        order by p.paid_at desc,p.id desc),'[]'::jsonb)
        into v_rows
      from public.payments p
      where p.tenant_id = p_tenant_id and p.site_id = p_site_id
        and exists (
          select 1 from public.subscribers s
          where s.id = p.subscriber_id and s.tenant_id = p.tenant_id and s.site_id = p.site_id
        );
    when 'company_accounts' then
      select coalesce(jsonb_agg(
        public.powerhub_delta_sync_project_company_account(p_tenant_id,p_site_id,ca.id)
        order by ca.id), '[]'::jsonb)
        into v_rows
      from public.company_accounts ca
      where ca.tenant_id=p_tenant_id and ca.is_active=true
        and exists (
          select 1 from public.company_account_sites link
          where link.tenant_id=ca.tenant_id and link.account_id=ca.id and link.site_id=p_site_id
        );
    when 'company_accounts_all' then
      select coalesce(jsonb_agg(
        public.powerhub_delta_sync_project_company_account(p_tenant_id,p_site_id,ca.id)
        order by ca.id), '[]'::jsonb)
        into v_rows
      from public.company_accounts ca
      where ca.tenant_id=p_tenant_id and ca.is_active=true;
    when 'tariffs' then
      select coalesce(jsonb_agg(public.powerhub_delta_sync_project_row('tariffs',to_jsonb(t)) order by t.effective_from desc,t.id desc),'[]'::jsonb)
        into v_rows from public.tariffs t
        where t.tenant_id=p_tenant_id and t.site_id=p_site_id;
  end case;
  return jsonb_build_object('status','ok','entity_type',p_entity_type,
    'snapshot_cursor',v_cursor::text,'retained_from_cursor',v_retained::text,'rows',v_rows);
end;
$$;
alter function public.powerhub_get_sync_snapshot(bigint,bigint,text) owner to postgres;
revoke all on function public.powerhub_get_sync_snapshot(bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_get_sync_snapshot(bigint,bigint,text) to service_role;



create or replace function public.powerhub_capture_delta_sync_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_old_tenant bigint;
  v_old_site bigint;
  v_new_tenant bigint;
  v_new_site bigint;
  v_entity_type text;
  v_entity_id text;
  v_change_type text;
  v_projected_new jsonb;
  v_tenant_name text;
  v_reading record;
begin
  v_entity_type := case TG_TABLE_NAME
    when 'sites' then 'sites'
    when 'subscribers' then 'subscribers'
    when 'generators' then 'generators'
    when 'meter_readings' then 'readings'
    when 'invoices' then 'invoices'
    when 'payments' then 'payments'
    when 'expenses' then 'expenses'
    when 'tariffs' then 'tariffs'
    else null
  end;
  if v_entity_type is null then
    raise exception 'POWERHUB_SYNC_TABLE_UNSUPPORTED' using errcode = 'P0001';
  end if;

  if TG_OP <> 'INSERT' then v_old := to_jsonb(OLD); end if;
  if TG_OP <> 'DELETE' then v_new := to_jsonb(NEW); end if;

  if TG_TABLE_NAME = 'sites' and v_old is not null then
    select t.name into v_tenant_name
    from public.tenants t where t.id = nullif(v_old ->> 'tenant_id', '')::bigint;
    if v_tenant_name is not null then
      v_old := v_old || jsonb_build_object('tenant_name', v_tenant_name);
    end if;
  end if;
  if TG_TABLE_NAME = 'sites' and v_new is not null then
    select t.name into v_tenant_name
    from public.tenants t where t.id = nullif(v_new ->> 'tenant_id', '')::bigint;
    if v_tenant_name is not null then
      v_new := v_new || jsonb_build_object('tenant_name', v_tenant_name);
    end if;
  end if;

  if v_old is not null then
    v_old_tenant := nullif(v_old ->> 'tenant_id', '')::bigint;
    if TG_TABLE_NAME = 'sites' then
      v_old_site := nullif(v_old ->> 'id', '')::bigint;
    elsif TG_TABLE_NAME = 'meter_readings' then
      select s.site_id into v_old_site
      from public.subscribers s
      where s.id = nullif(v_old ->> 'subscriber_id', '')::bigint
        and s.tenant_id = v_old_tenant;
    else
      v_old_site := nullif(v_old ->> 'site_id', '')::bigint;
    end if;
  end if;

  if v_new is not null then
    v_new_tenant := nullif(v_new ->> 'tenant_id', '')::bigint;
    if TG_TABLE_NAME = 'sites' then
      v_new_site := nullif(v_new ->> 'id', '')::bigint;
    elsif TG_TABLE_NAME = 'meter_readings' then
      select s.site_id into v_new_site
      from public.subscribers s
      where s.id = nullif(v_new ->> 'subscriber_id', '')::bigint
        and s.tenant_id = v_new_tenant;
    else
      v_new_site := nullif(v_new ->> 'site_id', '')::bigint;
    end if;
  end if;

  if TG_TABLE_NAME = 'meter_readings' then
    if v_old is not null and v_old_site is not null then v_old := v_old || jsonb_build_object('site_id',v_old_site); end if;
    if v_new is not null and v_new_site is not null then v_new := v_new || jsonb_build_object('site_id',v_new_site); end if;
  end if;

  if TG_OP = 'INSERT' then
    if v_new_tenant is not null and v_new_site is not null then
      if coalesce(v_new ->> 'archived_at', '') <> '' then
        perform public.powerhub_append_sync_change(v_new_tenant, v_new_site, v_entity_type, v_new ->> 'id', 'delete', null);
      else
        if TG_TABLE_NAME = 'payments' then
          v_projected_new := public.powerhub_delta_sync_project_payment(v_new_tenant, v_new_site, nullif(v_new ->> 'id', '')::bigint);
          if v_projected_new is null then
            raise exception 'POWERHUB_SYNC_PAYMENT_PROJECTION_MISSING' using errcode = 'P0001';
          end if;
        else
          v_projected_new := public.powerhub_delta_sync_project_row(v_entity_type, v_new);
        end if;
        perform public.powerhub_append_sync_change(v_new_tenant, v_new_site, v_entity_type, v_new ->> 'id', 'upsert', v_projected_new);
      end if;
    end if;
    return NEW;
  elsif TG_OP = 'DELETE' then
    if v_old_tenant is not null and v_old_site is not null then
      perform public.powerhub_append_sync_change(v_old_tenant, v_old_site, v_entity_type, v_old ->> 'id', 'delete', null);
    end if;
    return OLD;
  end if;

  if v_old is not distinct from v_new then
    return NEW;
  end if;

  -- A scope move removes the old copy before publishing the new scoped row.
  if v_old_tenant is not null and v_old_site is not null
     and (v_old_tenant is distinct from v_new_tenant or v_old_site is distinct from v_new_site) then
    perform public.powerhub_append_sync_change(v_old_tenant, v_old_site, v_entity_type, v_old ->> 'id', 'delete', null);
  elsif v_old_tenant is not null and v_old_site is not null
        and TG_TABLE_NAME = 'subscribers'
        and coalesce(v_old ->> 'archived_at', '') = ''
        and coalesce(v_new ->> 'archived_at', '') <> '' then
    perform public.powerhub_append_sync_change(v_old_tenant, v_old_site, v_entity_type, v_old ->> 'id', 'delete', null);
  end if;

  if v_new_tenant is not null and v_new_site is not null then
    if coalesce(v_new ->> 'archived_at', '') <> '' then
      if v_old_tenant is null or v_old_site is null
         or (v_old_tenant is distinct from v_new_tenant or v_old_site is distinct from v_new_site) then
        perform public.powerhub_append_sync_change(v_new_tenant, v_new_site, v_entity_type, v_new ->> 'id', 'delete', null);
      end if;
    else
      if TG_TABLE_NAME = 'payments' then
          v_projected_new := public.powerhub_delta_sync_project_payment(v_new_tenant, v_new_site, nullif(v_new ->> 'id', '')::bigint);
          if v_projected_new is null then
            raise exception 'POWERHUB_SYNC_PAYMENT_PROJECTION_MISSING' using errcode = 'P0001';
          end if;
        else
          v_projected_new := public.powerhub_delta_sync_project_row(v_entity_type, v_new);
        end if;
      perform public.powerhub_append_sync_change(v_new_tenant, v_new_site, v_entity_type, v_new ->> 'id', 'upsert', v_projected_new);
    end if;
  end if;

  -- Reading rows inherit scope from the subscriber; always tombstone the old cache
  -- on a tenant/site move. Upsert in the new scope only when the reading row already
  -- belongs to the new tenant; a later reading update will publish it otherwise.
  if TG_TABLE_NAME = 'subscribers'
     and v_old_tenant is not null and v_new_tenant is not null
     and v_old_site is not null and v_new_site is not null
     and (v_old_tenant is distinct from v_new_tenant or v_old_site is distinct from v_new_site) then
    for v_reading in
      select to_jsonb(r) as row_data, r.tenant_id as reading_tenant_id
      from public.meter_readings r
      where r.subscriber_id = (v_new ->> 'id')::bigint
        and r.tenant_id in (v_old_tenant, v_new_tenant)
    loop
      perform public.powerhub_append_sync_change(v_old_tenant, v_old_site, 'readings', v_reading.row_data ->> 'id', 'delete', null);
      if v_reading.reading_tenant_id = v_new_tenant then
        perform public.powerhub_append_sync_change(v_new_tenant, v_new_site, 'readings', v_reading.row_data ->> 'id', 'upsert',
          public.powerhub_delta_sync_project_row('readings', v_reading.row_data || jsonb_build_object('site_id', v_new_site)));
      end if;
    end loop;
  end if;

  return NEW;
end;
$$;

alter function public.powerhub_capture_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_delta_sync_change() to service_role;


create or replace function public.powerhub_pull_sync_delta(
  p_tenant_id bigint,
  p_site_id bigint,
  p_entity_type text,
  p_after_cursor bigint,
  p_through_cursor bigint default null,
  p_page_size integer default 200
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_current_cursor bigint := 0;
  v_retained_from bigint := 0;
  v_target_cursor bigint := 0;
  v_next_cursor bigint := 0;
  v_last_page_cursor bigint;
  v_has_more boolean := false;
  v_changes jsonb := '[]'::jsonb;
  v_row_count integer := 0;
begin
  if p_tenant_id is null or p_tenant_id < 1 or p_site_id is null or p_site_id < 1 then
    raise exception 'POWERHUB_SYNC_SCOPE_REQUIRED' using errcode = 'P0001';
  end if;
  if p_entity_type not in ('sites', 'subscribers', 'generators', 'readings', 'tariffs', 'invoices', 'payments', 'expenses', 'company_accounts', 'company_accounts_all') then
    raise exception 'POWERHUB_SYNC_ENTITY_UNSUPPORTED' using errcode = 'P0001';
  end if;
  if p_page_size is null or p_page_size < 1 or p_page_size > 500 then
    raise exception 'POWERHUB_SYNC_PAGE_SIZE_INVALID' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id
  ) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  select s.last_cursor, s.retained_from_cursor
    into v_current_cursor, v_retained_from
  from public.powerhub_sync_scope_state s
  where s.tenant_id = p_tenant_id and s.site_id = p_site_id and s.entity_type = p_entity_type;
  if not found then
    v_current_cursor := 0;
    v_retained_from := 0;
  end if;

  -- A missing cursor means the caller has no trusted snapshot. It must fetch the
  -- entity snapshot, then resume from this checkpoint to catch changes during load.
  if p_after_cursor is null or p_after_cursor < v_retained_from then
    return jsonb_build_object(
      'status', 'reset_required',
      'entity_type', p_entity_type,
      'current_cursor', v_current_cursor::text,
      'retained_from_cursor', v_retained_from::text,
      'snapshot_cursor', v_current_cursor::text,
      'through_cursor', v_current_cursor::text,
      'next_cursor', null,
      'has_more', false,
      'changes', '[]'::jsonb
    );
  end if;

  if p_after_cursor < 0 or p_after_cursor > v_current_cursor then
    raise exception 'POWERHUB_SYNC_CURSOR_INVALID' using errcode = 'P0001';
  end if;

  if p_through_cursor is null then
    v_target_cursor := v_current_cursor;
  else
    v_target_cursor := p_through_cursor;
    if v_target_cursor < p_after_cursor or v_target_cursor > v_current_cursor then
      raise exception 'POWERHUB_SYNC_TARGET_CURSOR_INVALID' using errcode = 'P0001';
    end if;
  end if;

  with page_rows as (
    select c.cursor, c.entity_type, c.entity_id, c.change_type, c.row_data, c.changed_at
    from public.powerhub_sync_changes c
    where c.tenant_id = p_tenant_id
      and c.site_id = p_site_id
      and c.entity_type = p_entity_type
      and c.cursor > p_after_cursor
      and c.cursor <= v_target_cursor
    order by c.cursor
    limit p_page_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'cursor', p.cursor::text,
           'entity_type', p.entity_type,
           'entity_id', p.entity_id,
           'operation', p.change_type,
           'row_data', p.row_data,
           'changed_at', p.changed_at
         ) order by p.cursor), '[]'::jsonb),
         max(p.cursor),
         count(*)::integer
    into v_changes, v_last_page_cursor, v_row_count
  from page_rows p;

  select exists (
    select 1 from public.powerhub_sync_changes c
    where c.tenant_id = p_tenant_id
      and c.site_id = p_site_id
      and c.entity_type = p_entity_type
      and c.cursor > coalesce(v_last_page_cursor, p_after_cursor)
      and c.cursor <= v_target_cursor
  ) into v_has_more;

  if v_has_more then
    v_next_cursor := coalesce(v_last_page_cursor, p_after_cursor);
  else
    v_next_cursor := v_target_cursor;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'entity_type', p_entity_type,
    'current_cursor', v_current_cursor::text,
    'retained_from_cursor', v_retained_from::text,
    'snapshot_cursor', null,
    'through_cursor', v_target_cursor::text,
    'next_cursor', v_next_cursor::text,
    'has_more', v_has_more,
    'changes', v_changes
  );
end;
$$;
alter function public.powerhub_pull_sync_delta(bigint, bigint, text, bigint, bigint, integer) owner to postgres;
revoke all on function public.powerhub_pull_sync_delta(bigint, bigint, text, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function public.powerhub_pull_sync_delta(bigint, bigint, text, bigint, bigint, integer) to service_role;


drop trigger if exists powerhub_delta_sync_expenses on public.expenses;
create trigger powerhub_delta_sync_expenses after insert or update or delete on public.expenses
for each row execute function public.powerhub_capture_delta_sync_change();
revoke all on function public.powerhub_delta_sync_project_row(text,jsonb) from public,anon,authenticated;
revoke all on function public.powerhub_get_sync_snapshot(bigint,bigint,text) from public,anon,authenticated;
revoke all on function public.powerhub_capture_delta_sync_change() from public,anon,authenticated;
revoke all on function public.powerhub_pull_sync_delta(bigint,bigint,text,bigint,bigint,integer) from public,anon,authenticated;


-- Publish one account projection to the relevant branch scopes and all-branches
-- scope. Related payment receipt keys/hashes are intentionally not projected.
create or replace function public.powerhub_publish_company_account_delta(
  p_tenant_id bigint,
  p_account_id bigint,
  p_extra_site_ids bigint[] default array[]::bigint[],
  p_deleted boolean default false
) returns void
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_account public.company_accounts%rowtype;
  v_account_exists boolean := false;
  v_deleted boolean := coalesce(p_deleted,false);
  v_site_id bigint;
  v_branch_sites bigint[];
  v_row jsonb;
begin
  if p_tenant_id is null or p_tenant_id < 1 or p_account_id is null or p_account_id < 1 then
    raise exception 'POWERHUB_SYNC_ACCOUNT_SCOPE_REQUIRED' using errcode='P0001';
  end if;

  select * into v_account
  from public.company_accounts ca
  where ca.tenant_id=p_tenant_id and ca.id=p_account_id;
  v_account_exists := found;
  if not v_account_exists or not coalesce(v_account.is_active,false) then
    v_deleted := true;
  end if;

  if coalesce(cardinality(p_extra_site_ids),0) > 0 then
    select coalesce(array_agg(distinct requested.site_id order by requested.site_id),array[]::bigint[])
      into v_branch_sites
    from unnest(p_extra_site_ids) requested(site_id)
    where requested.site_id is not null
      and exists(select 1 from public.sites s where s.id=requested.site_id and s.tenant_id=p_tenant_id);
  else
    select coalesce(array_agg(link.site_id order by link.site_id),array[]::bigint[])
      into v_branch_sites
    from public.company_account_sites link
    where link.tenant_id=p_tenant_id and link.account_id=p_account_id;
  end if;

  -- Branch feeds contain only accounts explicitly linked to that branch.
  foreach v_site_id in array v_branch_sites loop
    if not v_deleted and exists (
      select 1 from public.company_account_sites link
      where link.tenant_id=p_tenant_id and link.account_id=p_account_id and link.site_id=v_site_id
    ) then
      v_row := public.powerhub_delta_sync_project_company_account(p_tenant_id,v_site_id,p_account_id);
      if v_row is null then
        perform public.powerhub_append_sync_change(p_tenant_id,v_site_id,'company_accounts',p_account_id::text,'delete',null);
      else
        perform public.powerhub_append_sync_change(p_tenant_id,v_site_id,'company_accounts',p_account_id::text,'upsert',v_row);
      end if;
    else
      perform public.powerhub_append_sync_change(p_tenant_id,v_site_id,'company_accounts',p_account_id::text,'delete',null);
    end if;
  end loop;

  -- The all-branches stream is tenant-wide but uses an existing site as its cursor
  -- anchor. Publish to every tenant site so whichever authorized anchor is used
  -- observes the change without relying on a full refresh.
  for v_site_id in
    select s.id from public.sites s where s.tenant_id=p_tenant_id order by s.id
  loop
    if not v_deleted then
      v_row := public.powerhub_delta_sync_project_company_account(p_tenant_id,v_site_id,p_account_id);
    else
      v_row := null;
    end if;
    if v_row is null then
      perform public.powerhub_append_sync_change(p_tenant_id,v_site_id,'company_accounts_all',p_account_id::text,'delete',null);
    else
      perform public.powerhub_append_sync_change(p_tenant_id,v_site_id,'company_accounts_all',p_account_id::text,'upsert',v_row);
    end if;
  end loop;
end;
$$;
alter function public.powerhub_publish_company_account_delta(bigint,bigint,bigint[],boolean) owner to postgres;
revoke all on function public.powerhub_publish_company_account_delta(bigint,bigint,bigint[],boolean) from public,anon,authenticated;
grant execute on function public.powerhub_publish_company_account_delta(bigint,bigint,bigint[],boolean) to service_role;

create or replace function public.powerhub_capture_company_account_delta_sync_change()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_tenant_id bigint;
  v_old_id bigint;
  v_old_account_id bigint;
  v_old_occurred_at timestamptz;
  v_new_id bigint;
  v_new_account_id bigint;
  v_account_id bigint;
  v_extra_sites bigint[];
begin
  if TG_TABLE_NAME='company_accounts' then
    if TG_OP='DELETE' then
      select coalesce(array_agg(link.site_id order by link.site_id),array[]::bigint[])
        into v_extra_sites
      from public.company_account_sites link
      where link.tenant_id=OLD.tenant_id and link.account_id=OLD.id;
      perform public.powerhub_publish_company_account_delta(OLD.tenant_id,OLD.id,v_extra_sites,true);
      return OLD;
    end if;
    if TG_OP='UPDATE' and (OLD.tenant_id is distinct from NEW.tenant_id or OLD.id is distinct from NEW.id) then
      select coalesce(array_agg(link.site_id order by link.site_id),array[]::bigint[])
        into v_extra_sites from public.company_account_sites link
      where link.tenant_id=OLD.tenant_id and link.account_id=OLD.id;
      perform public.powerhub_publish_company_account_delta(OLD.tenant_id,OLD.id,v_extra_sites,true);
    end if;
    perform public.powerhub_publish_company_account_delta(NEW.tenant_id,NEW.id,array[]::bigint[],not coalesce(NEW.is_active,false));
    return NEW;
  elsif TG_TABLE_NAME='company_account_sites' then
    if TG_OP='DELETE' then
      if not exists(select 1 from public.company_accounts ca where ca.tenant_id=OLD.tenant_id and ca.id=OLD.account_id) then
        return OLD; -- Parent-account deletion already emitted its tombstones.
      end if;
      perform public.powerhub_publish_company_account_delta(OLD.tenant_id,OLD.account_id,array[OLD.site_id]::bigint[],false);
      return OLD;
    elsif TG_OP='INSERT' then
      perform public.powerhub_publish_company_account_delta(NEW.tenant_id,NEW.account_id,array[NEW.site_id]::bigint[],false);
      return NEW;
    end if;
    if OLD.tenant_id is not distinct from NEW.tenant_id and OLD.account_id is not distinct from NEW.account_id then
      perform public.powerhub_publish_company_account_delta(NEW.tenant_id,NEW.account_id,array[OLD.site_id,NEW.site_id]::bigint[],false);
    else
      perform public.powerhub_publish_company_account_delta(OLD.tenant_id,OLD.account_id,array[OLD.site_id]::bigint[],false);
      perform public.powerhub_publish_company_account_delta(NEW.tenant_id,NEW.account_id,array[NEW.site_id]::bigint[],false);
    end if;
    return NEW;
  elsif TG_TABLE_NAME='account_transactions' then
    if TG_OP<>'INSERT' then
      v_old_id := OLD.id;
      v_old_account_id := OLD.account_id;
      v_old_occurred_at := OLD.occurred_at;
    end if;
    if TG_OP<>'DELETE' then
      v_new_id := NEW.id;
      v_new_account_id := NEW.account_id;
    end if;
    v_tenant_id := case when TG_OP='DELETE' then OLD.tenant_id else NEW.tenant_id end;

    -- The visible account query carries the newest 1,000 tenant-wide transactions.
    -- Compare old/new membership at that boundary so evicted/previously-hidden rows
    -- cause their affected account projection to be republished too.
    for v_account_id in
      with old_candidates as (
        select tx.id,tx.account_id,tx.occurred_at
        from public.account_transactions tx
        where tx.tenant_id=v_tenant_id and tx.id is distinct from v_new_id
        union all
        select v_old_id,v_old_account_id,v_old_occurred_at where v_old_id is not null
      ),
      old_window as (
        select candidate.id,candidate.account_id
        from old_candidates candidate
        order by candidate.occurred_at desc,candidate.id desc
        limit 1000
      ),
      new_window as (
        select tx.id,tx.account_id
        from public.account_transactions tx
        where tx.tenant_id=v_tenant_id
        order by tx.occurred_at desc,tx.id desc
        limit 1000
      ),
      changed_window as (
        select o.account_id from old_window o
        where not exists(select 1 from new_window n where n.id=o.id)
        union
        select n.account_id from new_window n
        where not exists(select 1 from old_window o where o.id=n.id)
      ),
      affected as (
        select v_old_account_id as account_id where v_old_account_id is not null
        union select v_new_account_id where v_new_account_id is not null
        union select account_id from changed_window
      )
      select distinct account_id from affected where account_id is not null
    loop
      perform public.powerhub_publish_company_account_delta(v_tenant_id,v_account_id,array[]::bigint[],false);
    end loop;
    if TG_OP='DELETE' then return OLD; else return NEW; end if;
  end if;
  raise exception 'POWERHUB_SYNC_TABLE_UNSUPPORTED' using errcode='P0001';
end;
$$;
alter function public.powerhub_capture_company_account_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_company_account_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_company_account_delta_sync_change() to service_role;

drop trigger if exists powerhub_delta_sync_company_accounts on public.company_accounts;
create trigger powerhub_delta_sync_company_accounts
after insert or update on public.company_accounts
for each row execute function public.powerhub_capture_company_account_delta_sync_change();

drop trigger if exists powerhub_delta_sync_company_accounts_delete on public.company_accounts;
create trigger powerhub_delta_sync_company_accounts_delete
before delete on public.company_accounts
for each row execute function public.powerhub_capture_company_account_delta_sync_change();

drop trigger if exists powerhub_delta_sync_company_account_sites on public.company_account_sites;
create trigger powerhub_delta_sync_company_account_sites
after insert or update or delete on public.company_account_sites
for each row execute function public.powerhub_capture_company_account_delta_sync_change();

drop trigger if exists powerhub_delta_sync_account_transactions on public.account_transactions;
create trigger powerhub_delta_sync_account_transactions
after insert or update or delete on public.account_transactions
for each row execute function public.powerhub_capture_company_account_delta_sync_change();

revoke all on function public.powerhub_delta_sync_project_company_account(bigint,bigint,bigint) from public,anon,authenticated;
revoke all on function public.powerhub_get_sync_snapshot(bigint,bigint,text) from public,anon,authenticated;
revoke all on function public.powerhub_pull_sync_delta(bigint,bigint,text,bigint,bigint,integer) from public,anon,authenticated;
