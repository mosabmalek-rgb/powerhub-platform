-- Accelerate company-account history searches without changing field-level semantics.
-- A GIN candidate index is followed by exact original-field checks.
create extension if not exists pg_trgm with schema extensions;

create or replace function private.powerhub_account_transaction_search_document(
  p_description text,
  p_transaction_type text,
  p_id bigint,
  p_reference_no text,
  p_related_payment_id bigint,
  p_related_account_id bigint,
  p_occurred_at timestamptz
)
returns text
language sql
immutable
set search_path = ''
as $function$
  select
    coalesce(p_description,'') || chr(31) ||
    coalesce(p_transaction_type,'') || chr(31) ||
    case p_transaction_type
      when 'collection' then 'تحصيل'
      when 'deposit' then 'إيداع'
      when 'withdrawal' then 'سحب'
      when 'transfer_in' then 'تحويل وارد'
      when 'transfer_out' then 'تحويل صادر'
      else coalesce(p_transaction_type,'')
    end || chr(31) ||
    coalesce(p_id::text,'') || chr(31) ||
    coalesce(p_reference_no,'') || chr(31) ||
    coalesce(p_related_payment_id::text,'') || chr(31) ||
    coalesce(p_related_account_id::text,'') || chr(31) ||
    extract(year from (p_occurred_at at time zone 'Asia/Gaza'))::integer::text || '-' ||
    lpad(extract(month from (p_occurred_at at time zone 'Asia/Gaza'))::integer::text,2,'0') || '-' ||
    lpad(extract(day from (p_occurred_at at time zone 'Asia/Gaza'))::integer::text,2,'0');
$function$;

alter function private.powerhub_account_transaction_search_document(
  text,text,bigint,text,bigint,bigint,timestamptz
) owner to postgres;

revoke all on function private.powerhub_account_transaction_search_document(
  text,text,bigint,text,bigint,bigint,timestamptz
) from public,anon,authenticated;

grant execute on function private.powerhub_account_transaction_search_document(
  text,text,bigint,text,bigint,bigint,timestamptz
) to service_role;

do $account_history_trgm_index$
declare
  v_extension_schema text;
begin
  select n.nspname
    into v_extension_schema
  from pg_extension e
  join pg_namespace n on n.oid=e.extnamespace
  where e.extname='pg_trgm';

  if v_extension_schema is null then
    raise exception 'COMPANY_ACCOUNT_HISTORY_PG_TRGM_EXTENSION_MISSING';
  end if;

  execute format(
    'create index if not exists account_transactions_search_document_trgm_idx
       on public.account_transactions using gin (
         private.powerhub_account_transaction_search_document(
           description,transaction_type,id,reference_no,
           related_payment_id,related_account_id,occurred_at
         ) %I.gin_trgm_ops
       )',
    v_extension_schema
  );
end;
$account_history_trgm_index$;

create or replace function private.powerhub_company_account_history_search_matches(
  p_tenant_id bigint,
  p_account_id bigint,
  p_search text
)
returns setof bigint
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_search text := nullif(btrim(p_search),'');
  v_search_pattern text;
  v_related_account_ids bigint[] := '{}'::bigint[];
begin
  if v_search is null then
    return;
  end if;

  v_search_pattern :=   replace(replace(replace(v_search, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_');

  if char_length(v_search)<3 then
    return query
      select tx.id
      from public.account_transactions tx
      left join public.company_accounts counterpart
        on counterpart.tenant_id=tx.tenant_id
       and counterpart.id=tx.related_account_id
       and counterpart.is_active=true
      where tx.tenant_id=p_tenant_id
        and tx.account_id=p_account_id
        and (tx.description ilike '%' || v_search_pattern || '%' escape E'\\'
        or tx.transaction_type ilike '%' || v_search_pattern || '%' escape E'\\'
        or case tx.transaction_type
          when 'collection' then 'تحصيل'
          when 'deposit' then 'إيداع'
          when 'withdrawal' then 'سحب'
          when 'transfer_in' then 'تحويل وارد'
          when 'transfer_out' then 'تحويل صادر'
          else tx.transaction_type
        end ilike '%' || v_search_pattern || '%' escape E'\\'
        or tx.id::text ilike '%' || v_search_pattern || '%' escape E'\\'
        or coalesce(tx.reference_no, '') ilike '%' || v_search_pattern || '%' escape E'\\'
        or coalesce(tx.related_payment_id::text, '') ilike '%' || v_search_pattern || '%' escape E'\\'
        or coalesce(tx.related_account_id::text, '') ilike '%' || v_search_pattern || '%' escape E'\\'
        or coalesce(counterpart.name, case when tx.related_account_id is not null then 'حساب #' || tx.related_account_id::text else '' end) ilike '%' || v_search_pattern || '%' escape E'\\'
        or to_char(tx.occurred_at at time zone 'Asia/Gaza', 'YYYY-MM-DD') ilike '%' || v_search_pattern || '%' escape E'\\');
    return;
  end if;

  select coalesce(array_agg(ca.id),'{}'::bigint[])
    into v_related_account_ids
  from public.company_accounts ca
  where ca.tenant_id=p_tenant_id
    and (
      (ca.is_active=true and ca.name ilike '%' || v_search_pattern || '%' escape E'\\')
      or (ca.is_active=false and ('حساب #' || ca.id::text)
          ilike '%' || v_search_pattern || '%' escape E'\\')
    );

  return query
    select tx.id
    from public.account_transactions tx
    where tx.tenant_id=p_tenant_id
      and tx.account_id=p_account_id
      and private.powerhub_account_transaction_search_document(
        tx.description,tx.transaction_type,tx.id,tx.reference_no,
        tx.related_payment_id,tx.related_account_id,tx.occurred_at
      ) ilike '%' || v_search_pattern || '%' escape E'\\'
      and (tx.description ilike '%' || v_search_pattern || '%' escape E'\\'
        or tx.transaction_type ilike '%' || v_search_pattern || '%' escape E'\\'
        or case tx.transaction_type
          when 'collection' then 'تحصيل'
          when 'deposit' then 'إيداع'
          when 'withdrawal' then 'سحب'
          when 'transfer_in' then 'تحويل وارد'
          when 'transfer_out' then 'تحويل صادر'
          else tx.transaction_type
        end ilike '%' || v_search_pattern || '%' escape E'\\'
        or tx.id::text ilike '%' || v_search_pattern || '%' escape E'\\'
        or coalesce(tx.reference_no, '') ilike '%' || v_search_pattern || '%' escape E'\\'
        or coalesce(tx.related_payment_id::text, '') ilike '%' || v_search_pattern || '%' escape E'\\'
        or coalesce(tx.related_account_id::text, '') ilike '%' || v_search_pattern || '%' escape E'\\'
        or to_char(tx.occurred_at at time zone 'Asia/Gaza', 'YYYY-MM-DD') ilike '%' || v_search_pattern || '%' escape E'\\')
    union
    select tx.id
    from public.account_transactions tx
    where tx.tenant_id=p_tenant_id
      and tx.account_id=p_account_id
      and cardinality(v_related_account_ids)>0
      and tx.related_account_id=any(v_related_account_ids);
end;
$function$;

alter function private.powerhub_company_account_history_search_matches(bigint,bigint,text)
  owner to postgres;

revoke all on function private.powerhub_company_account_history_search_matches(bigint,bigint,text)
  from public,anon,authenticated,service_role;

create or replace function public.powerhub_company_account_history_page(
  p_tenant_id bigint,
  p_account_id bigint,
  p_branch_id bigint default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_movement_from date default null,
  p_movement_to date default null,
  p_transaction_type text default null,
  p_search text default null,
  p_cursor_at timestamptz default null,
  p_cursor_id bigint default null,
  p_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_limit integer := least(200, greatest(1, coalesce(p_limit, 10)));
  v_search text := nullif(btrim(p_search), '');
  v_opening_balance numeric;
  v_current_balance numeric;
  v_total_count bigint := 0;
  v_incoming_total numeric := 0;
  v_outgoing_total numeric := 0;
  v_items jsonb := '[]'::jsonb;
  v_has_next boolean := false;
  v_next_cursor_at timestamptz;
  v_next_cursor_id bigint;
  v_balance_timeline jsonb := '[]'::jsonb;
begin
  if p_tenant_id is null or p_tenant_id <= 0 or p_account_id is null or p_account_id <= 0 then
    raise exception 'COMPANY_ACCOUNT_HISTORY_INVALID_SCOPE' using errcode = '22023';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'COMPANY_ACCOUNT_HISTORY_INVALID_DATE_RANGE' using errcode = '22023';
  end if;
  if p_movement_from is not null and p_movement_to is not null and p_movement_from > p_movement_to then
    raise exception 'COMPANY_ACCOUNT_HISTORY_INVALID_MOVEMENT_DATE_RANGE' using errcode = '22023';
  end if;
  if (p_cursor_at is null) <> (p_cursor_id is null) or (p_cursor_id is not null and p_cursor_id <= 0) then
    raise exception 'COMPANY_ACCOUNT_HISTORY_INVALID_CURSOR' using errcode = '22023';
  end if;
  if length(coalesce(v_search, '')) > 120 then
    raise exception 'COMPANY_ACCOUNT_HISTORY_SEARCH_TOO_LONG' using errcode = '22023';
  end if;

  select ca.opening_balance
    into v_opening_balance
  from public.company_accounts ca
  where ca.id = p_account_id
    and ca.tenant_id = p_tenant_id
    and ca.is_active = true;

  if not found then
    raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_branch_id is not null and not exists (
    select 1
    from public.company_account_sites cas
    where cas.tenant_id = p_tenant_id
      and cas.account_id = p_account_id
      and cas.site_id = p_branch_id
  ) then
    raise exception 'ACCOUNT_SITE_OUT_OF_SCOPE' using errcode = '42501';
  end if;

  if p_cursor_at is null then
    -- Aggregate matching rows in the database. This preserves the former full
    -- result summary without loading every movement into the browser.
    select
      count(*),
      coalesce(sum(case when tx.transaction_type in ('collection', 'deposit', 'transfer_in') then tx.amount else 0 end), 0),
      coalesce(sum(case when tx.transaction_type in ('withdrawal', 'transfer_out') then tx.amount else 0 end), 0)
      into v_total_count, v_incoming_total, v_outgoing_total
    from public.account_transactions tx
    left join public.company_accounts counterpart
      on counterpart.tenant_id = tx.tenant_id
     and counterpart.id = tx.related_account_id
     and counterpart.is_active = true
    where tx.tenant_id = p_tenant_id
      and tx.account_id = p_account_id
      and (p_branch_id is null or tx.site_id = p_branch_id)
      and (p_from is null or tx.occurred_at >= p_from)
      and (p_to is null or tx.occurred_at <= p_to)
      and (p_movement_from is null or (tx.occurred_at at time zone 'Asia/Gaza')::date >= p_movement_from)
      and (p_movement_to is null or (tx.occurred_at at time zone 'Asia/Gaza')::date <= p_movement_to)
      and (p_transaction_type is null or tx.transaction_type = p_transaction_type)
      and (
        v_search is null
        or tx.id in (
          select matched.matched_id
          from private.powerhub_company_account_history_search_matches(
            p_tenant_id,p_account_id,v_search
          ) as matched(matched_id)
        )
      );
  end if;

  with page_plus as materialized (
    select
      tx.id,
      tx.tenant_id,
      tx.account_id,
      tx.site_id,
      tx.transaction_type,
      tx.amount,
      tx.description,
      tx.reference_no,
      tx.related_payment_id,
      tx.related_account_id,
      tx.created_by_user_id,
      tx.occurred_at,
      tx.created_at
    from public.account_transactions tx
    left join public.company_accounts counterpart
      on counterpart.tenant_id = tx.tenant_id
     and counterpart.id = tx.related_account_id
     and counterpart.is_active = true
    where tx.tenant_id = p_tenant_id
      and tx.account_id = p_account_id
      and (p_branch_id is null or tx.site_id = p_branch_id)
      and (p_from is null or tx.occurred_at >= p_from)
      and (p_to is null or tx.occurred_at <= p_to)
      and (p_movement_from is null or (tx.occurred_at at time zone 'Asia/Gaza')::date >= p_movement_from)
      and (p_movement_to is null or (tx.occurred_at at time zone 'Asia/Gaza')::date <= p_movement_to)
      and (p_transaction_type is null or tx.transaction_type = p_transaction_type)
      and (
        v_search is null
        or tx.id in (
          select matched.matched_id
          from private.powerhub_company_account_history_search_matches(
            p_tenant_id,p_account_id,v_search
          ) as matched(matched_id)
        )
      )
      and (
        p_cursor_at is null
        or (tx.occurred_at, tx.id) < (p_cursor_at, p_cursor_id)
      )
    order by tx.occurred_at desc, tx.id desc
    limit v_limit + 1
  ),
  page_rows_base as materialized (
    select *
    from page_plus
    order by occurred_at desc, id desc
    limit v_limit
  ),
  page_bounds as (
    -- The page head/tail bound the small movement window needed to translate
    -- the balance at the head into each row's historical balance. Include all
    -- account movements in that window, not only rows visible in this branch.
    select
      (select p.occurred_at from page_rows_base p order by p.occurred_at desc, p.id desc limit 1) as head_at,
      (select p.id from page_rows_base p order by p.occurred_at desc, p.id desc limit 1) as head_id,
      (select p.occurred_at from page_rows_base p order by p.occurred_at asc, p.id asc limit 1) as tail_at,
      (select p.id from page_rows_base p order by p.occurred_at asc, p.id asc limit 1) as tail_id
  ),
  balance_at_head as materialized (
    select
      v_opening_balance + coalesce(sum(
        case
          when tx.transaction_type in ('withdrawal', 'transfer_out') then -tx.amount
          else tx.amount
        end
      ), 0) as balance
    from page_bounds bounds
    left join public.account_transactions tx
      on tx.tenant_id = p_tenant_id
     and tx.account_id = p_account_id
     and (tx.occurred_at, tx.id) <= (bounds.head_at, bounds.head_id)
    where p_from is null
      and p_to is null
      and bounds.head_at is not null
  ),
  movement_steps as materialized (
    select
      tx.id,
      coalesce(sum(
        case
          when tx.transaction_type in ('withdrawal', 'transfer_out') then -tx.amount
          else tx.amount
        end
      ) over (
        order by tx.occurred_at desc, tx.id desc
        rows between unbounded preceding and 1 preceding
      ), 0) as newer_delta
    from page_bounds bounds
    join public.account_transactions tx
      on tx.tenant_id = p_tenant_id
     and tx.account_id = p_account_id
     and (tx.occurred_at, tx.id) <= (bounds.head_at, bounds.head_id)
     and (tx.occurred_at, tx.id) >= (bounds.tail_at, bounds.tail_id)
    where p_from is null
      and p_to is null
      and bounds.head_at is not null
  ),
  page_rows as (
    select
      page_rows_base.*,
      case
        when p_from is not null or p_to is not null then null
        else balance_at_head.balance - movement_steps.newer_delta
      end as balance_after
    from page_rows_base
    left join balance_at_head on true
    left join movement_steps on movement_steps.id = page_rows_base.id
    order by page_rows_base.occurred_at desc, page_rows_base.id desc
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'id', row_data.id,
        'tenant_id', row_data.tenant_id,
        'account_id', row_data.account_id,
        'site_id', row_data.site_id,
        'transaction_type', row_data.transaction_type,
        'amount', row_data.amount,
        'description', row_data.description,
        'reference_no', row_data.reference_no,
        'related_payment_id', row_data.related_payment_id,
        'related_account_id', row_data.related_account_id,
        'created_by_user_id', row_data.created_by_user_id,
        'occurred_at', row_data.occurred_at,
        'created_at', row_data.created_at,
        'balance_after', row_data.balance_after
      ) order by row_data.occurred_at desc, row_data.id desc
    ), '[]'::jsonb),
    (select count(*) > v_limit from page_plus),
    (select row_data.occurred_at from page_rows row_data order by row_data.occurred_at asc, row_data.id asc limit 1),
    (select row_data.id from page_rows row_data order by row_data.occurred_at asc, row_data.id asc limit 1)
    into v_items, v_has_next, v_next_cursor_at, v_next_cursor_id
  from page_rows row_data;

  -- The chart is an aggregate daily series and is intentionally omitted for a
  -- single-branch view, where the shared account balance also includes hidden
  -- branch movements. It is also hidden for an explicit top-level UTC window.
  if p_branch_id is null and p_from is null and p_to is null and p_cursor_at is null then
    -- When the history page is unfiltered, its newest row already carries the
    -- account's current balance. Reuse it instead of scanning the entire ledger
    -- a second time for the chart's current-balance value. Filtered chart
    -- requests keep the historical opening-balance calculation below because
    -- the first returned row may not be the newest account movement.
    if p_movement_from is null
       and p_movement_to is null
       and p_transaction_type is null
       and v_search is null then
      v_current_balance := coalesce(
        (v_items #>> '{0,balance_after}')::numeric,
        v_opening_balance
      );

      -- Materialize daily groups before ordering the small timeline window. This
      -- avoids sorting every ledger row by local movement day on large accounts.
      with daily_movements as materialized (
        select
          (tx.occurred_at at time zone 'Asia/Gaza')::date as movement_day,
          sum(case
            when tx.transaction_type in ('withdrawal', 'transfer_out') then -tx.amount
            else tx.amount
          end) as net_amount
        from public.account_transactions tx
        where tx.tenant_id = p_tenant_id
          and tx.account_id = p_account_id
        group by (tx.occurred_at at time zone 'Asia/Gaza')::date
      ),
      timeline as (
        select
          daily_movements.movement_day,
          v_opening_balance
            + sum(daily_movements.net_amount) over (
              order by daily_movements.movement_day
              rows between unbounded preceding and current row
            ) as balance
        from daily_movements
      )
      select coalesce(
        jsonb_agg(
          jsonb_build_object('day', timeline.movement_day::text, 'balance', timeline.balance)
          order by timeline.movement_day
        ) filter (where timeline.movement_day is not null),
        '[]'::jsonb
      )
      into v_balance_timeline
      from timeline;
    else
    -- Materialize daily groups before ordering the small timeline window. This
      -- avoids sorting every ledger row by local movement day on large accounts.
      with daily_movements as materialized (
      select
        (tx.occurred_at at time zone 'Asia/Gaza')::date as movement_day,
        sum(case
          when tx.transaction_type in ('withdrawal', 'transfer_out') then -tx.amount
          else tx.amount
        end) as net_amount
      from public.account_transactions tx
      where tx.tenant_id = p_tenant_id
        and tx.account_id = p_account_id
        and (p_movement_from is null or (tx.occurred_at at time zone 'Asia/Gaza')::date >= p_movement_from)
        and (p_movement_to is null or (tx.occurred_at at time zone 'Asia/Gaza')::date <= p_movement_to)
      group by (tx.occurred_at at time zone 'Asia/Gaza')::date
    ),
    first_day as (
      select min(daily_movements.movement_day) as movement_day from daily_movements
    ),
    opening_balance as (
      select
        v_opening_balance + coalesce(sum(
          case
            when tx.transaction_type in ('withdrawal', 'transfer_out') then -tx.amount
            else tx.amount
          end
        ) filter (
          where first_day.movement_day is not null
            and (tx.occurred_at at time zone 'Asia/Gaza')::date < first_day.movement_day
        ), 0) as balance,
        v_opening_balance + coalesce(sum(
          case
            when tx.transaction_type in ('withdrawal', 'transfer_out') then -tx.amount
            else tx.amount
          end
        ), 0) as current_balance
      from first_day
      left join public.account_transactions tx
        on tx.tenant_id = p_tenant_id
       and tx.account_id = p_account_id
    ),
    timeline as (
      select
        daily_movements.movement_day,
        opening_balance.balance
          + sum(daily_movements.net_amount) over (order by daily_movements.movement_day rows between unbounded preceding and current row) as balance
      from daily_movements
      cross join opening_balance
    )
    select
      coalesce(
        jsonb_agg(
          jsonb_build_object('day', timeline.movement_day::text, 'balance', timeline.balance)
          order by timeline.movement_day
        ) filter (where timeline.movement_day is not null),
        '[]'::jsonb
      ),
      max(opening_balance.current_balance)
    into v_balance_timeline, v_current_balance
    from opening_balance
    left join timeline on true;
    end if;
  end if;
  if jsonb_array_length(v_balance_timeline) = 0 and p_branch_id is null and p_from is null and p_to is null and p_cursor_at is null then
    v_balance_timeline := jsonb_build_array(jsonb_build_object('day', null, 'balance', v_current_balance));
  end if;

  return jsonb_build_object(
    'items', v_items,
    'total_count', case when p_cursor_at is null then v_total_count else null end,
    'incoming_total', case when p_cursor_at is null then v_incoming_total else null end,
    'outgoing_total', case when p_cursor_at is null then v_outgoing_total else null end,
    'has_next', v_has_next,
    'next_cursor_at', case when v_has_next then v_next_cursor_at else null end,
    'next_cursor_id', case when v_has_next then v_next_cursor_id else null end,
    'balance_timeline', case when p_cursor_at is null then v_balance_timeline else null end
  );
end;
$function$;

alter function public.powerhub_company_account_history_page(
  bigint,bigint,bigint,timestamptz,timestamptz,date,date,text,text,timestamptz,bigint,integer
) owner to postgres;

revoke all on function public.powerhub_company_account_history_page(
  bigint,bigint,bigint,timestamptz,timestamptz,date,date,text,text,timestamptz,bigint,integer
) from public,anon,authenticated;

grant execute on function public.powerhub_company_account_history_page(
  bigint,bigint,bigint,timestamptz,timestamptz,date,date,text,text,timestamptz,bigint,integer
) to service_role;

notify pgrst, 'reload schema';
