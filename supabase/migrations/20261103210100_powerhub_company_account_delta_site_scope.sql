-- Branch-local history for shared company accounts.
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
        and (p_site_id is null or link.site_id = p_site_id)
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
        'site_id', bounded.site_id,
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
          and tx.account_id = ca.id
          and (p_site_id is null or tx.site_id = p_site_id)
        order by tx.occurred_at desc, tx.id desc
        limit 1000
      ) bounded
      where bounded.account_id = ca.id
    ), '[]'::jsonb)
  )
  from public.company_accounts ca
  where ca.tenant_id = p_tenant_id and ca.id = p_account_id and ca.is_active = true;
$$;

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
      v_row := public.powerhub_delta_sync_project_company_account(p_tenant_id,null,p_account_id);
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
        public.powerhub_delta_sync_project_company_account(p_tenant_id,null,ca.id)
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

DO $republish$
DECLARE account_row record;
BEGIN
  FOR account_row IN SELECT ca.tenant_id,ca.id FROM public.company_accounts ca WHERE ca.is_active ORDER BY ca.tenant_id,ca.id
  LOOP
    PERFORM public.powerhub_publish_company_account_delta(account_row.tenant_id,account_row.id,array[]::bigint[],false);
  END LOOP;
END
$republish$;

NOTIFY pgrst,'reload schema';
