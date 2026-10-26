-- Move PowerHub dashboard summaries into PostgreSQL so the API sends compact KPI payloads,
-- not every historical invoice/payment/expense row. These RPCs are service-role-only:
-- the application must authorize the tenant/site scope before calling them.

create or replace function public.powerhub_dashboard_operational_summary(
  p_tenant_id bigint,
  p_site_id bigint default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with scoped_sites as materialized (
    select s.id
    from public.sites s
    where s.tenant_id = p_tenant_id
      and s.status <> 'archived'
      and (p_site_id is null or s.id = p_site_id)
  ),
  subscriber_counts as (
    select s.site_id,
      count(*) filter (where s.service_status = 'active')::bigint as active_count
    from public.subscribers s
    join scoped_sites ss on ss.id = s.site_id
    where s.tenant_id = p_tenant_id
      and s.archived_at is null
    group by s.site_id
  ),
  generator_counts as (
    select g.site_id,
      count(*) filter (where g.status = 'active')::bigint as active_count,
      count(*) filter (where g.status = 'maintenance')::bigint as maintenance_count
    from public.generators g
    join scoped_sites ss on ss.id = g.site_id
    where g.tenant_id = p_tenant_id
    group by g.site_id
  ),
  invoice_totals as (
    select
      coalesce(sum(i.total_amount), 0)::numeric as invoiced,
      coalesce(sum(i.paid_amount), 0)::numeric as collected,
      coalesce(sum(i.balance_due), 0)::numeric as outstanding,
      coalesce(sum(i.consumption_kwh), 0)::numeric as energy_kwh
    from public.invoices i
    join scoped_sites ss on ss.id = i.site_id
    where i.tenant_id = p_tenant_id
      and i.status not in ('cancelled', 'draft')
  ),
  expense_totals as (
    select coalesce(sum(e.amount), 0)::numeric as expenses
    from public.expenses e
    join scoped_sites ss on ss.id = e.site_id
    where e.tenant_id = p_tenant_id
  ),
  notification_totals as (
    select count(*)::bigint as failed_count
    from public.notification_messages nm
    join public.subscribers s
      on s.id = nm.subscriber_id
      and s.tenant_id = nm.tenant_id
    join scoped_sites ss on ss.id = s.site_id
    where nm.tenant_id = p_tenant_id
      and nm.status = 'failed'
      and s.archived_at is null
  )
  select jsonb_build_object(
    'branchCount', (select count(*)::integer from scoped_sites),
    'subscribers', coalesce((select sum(active_count) from subscriber_counts), 0),
    'generators', jsonb_build_object(
      'active', coalesce((select sum(active_count) from generator_counts), 0),
      'maintenance', coalesce((select sum(maintenance_count) from generator_counts), 0)
    ),
    'financial', jsonb_build_object(
      'invoiced', (select invoiced from invoice_totals),
      'collected', (select collected from invoice_totals),
      'outstanding', (select outstanding from invoice_totals),
      'expenses', (select expenses from expense_totals),
      'operatingProfit', (select collected from invoice_totals) - (select expenses from expense_totals)
    ),
    'energyKwh', (select energy_kwh from invoice_totals),
    'failedNotifications', coalesce((select failed_count from notification_totals), 0)
  );
$$;

create or replace function public.powerhub_dashboard_financial_overview(
  p_tenant_id bigint,
  p_site_id bigint default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_today_start timestamptz;
  v_tomorrow_start timestamptz;
  v_month_start timestamptz;
  v_next_month_start timestamptz;
  v_trend_start timestamptz;
begin
  -- The existing UI and financial calculations use UTC day/month boundaries.
  v_today_start := date_trunc('day', v_now at time zone 'UTC') at time zone 'UTC';
  v_tomorrow_start := v_today_start + interval '1 day';
  v_month_start := date_trunc('month', v_now at time zone 'UTC') at time zone 'UTC';
  v_next_month_start := v_month_start + interval '1 month';
  v_trend_start := v_tomorrow_start - interval '31 days';

  return (
    with scope_sites as materialized (
      select s.id, s.name
      from public.sites s
      where s.tenant_id = p_tenant_id
        and s.status <> 'archived'
        and (p_site_id is null or s.id = p_site_id)
    ),
    -- Lifetime debt is needed, but settled historical invoice rows are never sent
    -- to the application. The database returns grouped debt and current-period KPIs.
    open_invoices as materialized (
      select i.id, i.site_id, i.subscriber_id, i.invoice_no, i.issue_date,
        i.due_date, i.total_amount, i.paid_amount, i.balance_due, i.status
      from public.invoices i
      join scope_sites ss on ss.id = i.site_id
      where i.tenant_id = p_tenant_id
        and i.status not in ('cancelled', 'draft')
        and i.balance_due > 0
    ),
    current_month_invoices as materialized (
      select i.id, i.site_id, i.issue_date, i.total_amount
      from public.invoices i
      join scope_sites ss on ss.id = i.site_id
      where i.tenant_id = p_tenant_id
        and i.status not in ('cancelled', 'draft')
        and i.issue_date >= v_month_start
        and i.issue_date < v_next_month_start
    ),
    invoice_stats as (
      select
        coalesce(sum(i.total_amount) filter (where i.issue_date >= v_today_start and i.issue_date < v_tomorrow_start), 0)::numeric as today_invoiced,
        coalesce(sum(i.total_amount), 0)::numeric as month_invoiced
      from current_month_invoices i
    ),
    payment_window as materialized (
      select p.site_id, p.subscriber_id, p.amount, p.status, p.paid_at
      from public.payments p
      join scope_sites ss on ss.id = p.site_id
      where p.tenant_id = p_tenant_id
        and p.status = 'completed'
        and p.paid_at >= v_trend_start
        and p.paid_at < v_tomorrow_start
    ),
    payment_stats as (
      select
        coalesce(sum(p.amount) filter (where p.paid_at >= v_today_start and p.paid_at < v_tomorrow_start), 0)::numeric as today_collected,
        coalesce(sum(p.amount) filter (where p.paid_at >= v_month_start and p.paid_at < v_next_month_start), 0)::numeric as month_collected
      from payment_window p
    ),
    expense_window as materialized (
      select e.site_id, e.amount, e.occurred_at
      from public.expenses e
      join scope_sites ss on ss.id = e.site_id
      where e.tenant_id = p_tenant_id
        and e.occurred_at >= v_trend_start
        and e.occurred_at < v_tomorrow_start
    ),
    expense_stats as (
      select coalesce(sum(e.amount) filter (where e.occurred_at >= v_month_start and e.occurred_at < v_next_month_start), 0)::numeric as month_expenses
      from expense_window e
    ),
    open_invoice_totals as (
      select
        coalesce(sum(i.balance_due), 0)::numeric as total_outstanding,
        coalesce(sum(i.balance_due) filter (where i.due_date < v_now), 0)::numeric as overdue_outstanding,
        count(*) filter (where i.status = 'partially_paid')::bigint as partial_invoice_count
      from open_invoices i
    ),
    debtor_totals as (
      select i.site_id, i.subscriber_id,
        coalesce(sum(i.balance_due), 0)::numeric as outstanding,
        count(*)::bigint as invoice_count,
        count(*) filter (where i.status = 'partially_paid')::bigint as partial_invoice_count,
        min(i.due_date) as oldest_due_date,
        bool_or(i.due_date < v_now) as is_overdue
      from open_invoices i
      group by i.site_id, i.subscriber_id
    ),
    branch_rows as (
      select ss.id, ss.name,
        (select count(*)::bigint from public.subscribers s
          where s.tenant_id = p_tenant_id and s.site_id = ss.id and s.service_status = 'active' and s.archived_at is null) as active_subscribers,
        coalesce((select sum(i.total_amount) from current_month_invoices i where i.site_id = ss.id), 0)::numeric as invoiced,
        coalesce((select sum(p.amount) from payment_window p
          where p.site_id = ss.id and p.paid_at >= v_month_start and p.paid_at < v_next_month_start), 0)::numeric as collected,
        coalesce((select sum(i.balance_due) from open_invoices i where i.site_id = ss.id), 0)::numeric as outstanding,
        coalesce((select sum(i.balance_due) from open_invoices i where i.site_id = ss.id and i.due_date < v_now), 0)::numeric as overdue,
        coalesce((select count(*) from open_invoices i where i.site_id = ss.id and i.status = 'partially_paid'), 0)::bigint as partial_invoice_count
      from scope_sites ss
    ),
    debtor_rows as (
      select d.*,
        coalesce(s.full_name, 'مشترك') as subscriber_name,
        coalesce(s.subscriber_no, '—') as subscriber_no,
        ss.name as branch_name,
        oldest.id as invoice_id,
        oldest.invoice_no,
        last_payment.last_payment_at
      from debtor_totals d
      join scope_sites ss on ss.id = d.site_id
      left join public.subscribers s
        on s.id = d.subscriber_id and s.tenant_id = p_tenant_id and s.site_id = d.site_id
      left join lateral (
        select i.id, i.invoice_no
        from open_invoices i
        where i.site_id = d.site_id and i.subscriber_id = d.subscriber_id
        order by i.due_date asc, i.id asc
        limit 1
      ) oldest on true
      left join lateral (
        select max(p.paid_at) as last_payment_at
        from public.payments p
        where p.tenant_id = p_tenant_id
          and p.site_id = d.site_id
          and p.subscriber_id = d.subscriber_id
          and p.status = 'completed'
      ) last_payment on true
      order by d.is_overdue desc, d.outstanding desc, d.site_id, d.subscriber_id
      limit 10
    ),
    outstanding_invoice_rows as (
      select i.*,
        coalesce(s.full_name, 'مشترك') as subscriber_name,
        coalesce(s.subscriber_no, '—') as subscriber_no,
        (i.due_date < v_now) as is_overdue,
        case when i.due_date < v_now then greatest(1, floor(extract(epoch from (v_now - i.due_date)) / 86400)::integer) else 0 end as age_days
      from open_invoices i
      left join public.subscribers s
        on s.id = i.subscriber_id and s.tenant_id = p_tenant_id and s.site_id = i.site_id
      order by (i.due_date < v_now) desc, i.balance_due desc,
        greatest(0, floor(extract(epoch from (v_now - i.due_date)) / 86400)::integer) desc,
        i.id desc
    ),
    outstanding_invoices_json as (
      select coalesce(jsonb_agg(jsonb_build_object(
        'siteId', i.site_id,
        'subscriberId', i.subscriber_id,
        'subscriber', i.subscriber_name,
        'subscriberNo', i.subscriber_no,
        'invoiceId', i.id,
        'invoiceNo', i.invoice_no,
        'outstanding', i.balance_due,
        'dueDate', to_char(i.due_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'isOverdue', i.is_overdue,
        'ageDays', i.age_days,
        'partialInvoices', case when i.status = 'partially_paid' then 1 else 0 end,
        'status', i.status
      ) order by i.is_overdue desc, i.balance_due desc, i.age_days desc, i.id desc), '[]'::jsonb) as value
      from outstanding_invoice_rows i
    ),
    top_debtors_json as (
      select coalesce(jsonb_agg(jsonb_build_object(
        'siteId', d.site_id,
        'subscriberId', d.subscriber_id,
        'subscriber', d.subscriber_name,
        'subscriberNo', d.subscriber_no,
        'outstanding', d.outstanding,
        'invoiceCount', d.invoice_count,
        'partialInvoices', d.partial_invoice_count,
        'invoiceId', d.invoice_id,
        'invoiceNo', d.invoice_no,
        'oldestDueDate', to_char(d.oldest_due_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'isOverdue', d.is_overdue,
        'ageDays', case when d.is_overdue then greatest(1, floor(extract(epoch from (v_now - d.oldest_due_date)) / 86400)::integer) else 0 end,
        'lastPaymentAt', case when d.last_payment_at is null then null else to_char(d.last_payment_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'branchName', d.branch_name
      ) order by d.is_overdue desc, d.outstanding desc, d.site_id, d.subscriber_id), '[]'::jsonb) as value
      from debtor_rows d
    ),
    trend_dates as (
      select generate_series(
        ((v_trend_start at time zone 'UTC')::date)::timestamp,
        ((v_today_start at time zone 'UTC')::date)::timestamp,
        interval '1 day'
      )::date as day
    ),
    invoice_daily as (
      select (i.issue_date at time zone 'UTC')::date as day, sum(i.total_amount)::numeric as invoiced
      from public.invoices i
      join scope_sites ss on ss.id = i.site_id
      where i.tenant_id = p_tenant_id
        and i.status not in ('cancelled', 'draft')
        and i.issue_date >= v_trend_start
        and i.issue_date < v_tomorrow_start
      group by (i.issue_date at time zone 'UTC')::date
    ),
    payment_daily as (
      select (p.paid_at at time zone 'UTC')::date as day, sum(p.amount)::numeric as collected
      from payment_window p
      group by (p.paid_at at time zone 'UTC')::date
    ),
    expense_daily as (
      select (e.occurred_at at time zone 'UTC')::date as day, sum(e.amount)::numeric as expenses
      from expense_window e
      group by (e.occurred_at at time zone 'UTC')::date
    ),
    trend_json as (
      select coalesce(jsonb_agg(jsonb_build_object(
        'date', to_char(d.day, 'YYYY-MM-DD'),
        'invoiced', coalesce(i.invoiced, 0),
        'collected', coalesce(p.collected, 0),
        'expenses', coalesce(e.expenses, 0),
        'netCash', coalesce(p.collected, 0) - coalesce(e.expenses, 0)
      ) order by d.day), '[]'::jsonb) as value
      from trend_dates d
      left join invoice_daily i on i.day = d.day
      left join payment_daily p on p.day = d.day
      left join expense_daily e on e.day = d.day
    ),
    branch_json as (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', b.id,
        'name', b.name,
        'activeSubscribers', b.active_subscribers,
        'invoiced', b.invoiced,
        'collected', b.collected,
        'outstanding', b.outstanding,
        'overdue', b.overdue,
        'partialInvoices', b.partial_invoice_count,
        'collectionRate', case when b.invoiced > 0 then b.collected / b.invoiced * 100 else 0 end
      ) order by b.outstanding desc, case when b.invoiced > 0 then b.collected / b.invoiced * 100 else 0 end asc), '[]'::jsonb) as value
      from branch_rows b
    )
    select jsonb_build_object(
      'generatedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'period', jsonb_build_object(
        'today', to_char(v_today_start at time zone 'UTC', 'YYYY-MM-DD'),
        'month', to_char(v_month_start at time zone 'UTC', 'YYYY-MM')
      ),
      'today', jsonb_build_object(
        'invoiced', (select today_invoiced from invoice_stats),
        'collected', (select today_collected from payment_stats),
        'collectionRate', case when (select today_invoiced from invoice_stats) > 0
          then (select today_collected from payment_stats) / (select today_invoiced from invoice_stats) * 100 else 0 end
      ),
      'month', jsonb_build_object(
        'invoiced', (select month_invoiced from invoice_stats),
        'collected', (select month_collected from payment_stats),
        'expenses', (select month_expenses from expense_stats),
        'netCash', (select month_collected from payment_stats) - (select month_expenses from expense_stats),
        'collectionRate', case when (select month_invoiced from invoice_stats) > 0
          then (select month_collected from payment_stats) / (select month_invoiced from invoice_stats) * 100 else 0 end
      ),
      'outstanding', jsonb_build_object(
        'total', (select total_outstanding from open_invoice_totals),
        'overdue', (select overdue_outstanding from open_invoice_totals),
        'partialInvoices', (select partial_invoice_count from open_invoice_totals),
        'accountCount', (select count(*)::bigint from debtor_totals)
      ),
      'branchSummaries', (select value from branch_json),
      'topDebtors', (select value from top_debtors_json),
      'outstandingInvoices', (select value from outstanding_invoices_json),
      'trend', (select value from trend_json)
    )
  );
end;
$$;

-- Service-role-only RPCs. Callers must authorize tenant/site access before supplying IDs.
alter function public.powerhub_dashboard_operational_summary(bigint, bigint) owner to postgres;
revoke all on function public.powerhub_dashboard_operational_summary(bigint, bigint) from public, anon, authenticated;
grant execute on function public.powerhub_dashboard_operational_summary(bigint, bigint) to service_role;

alter function public.powerhub_dashboard_financial_overview(bigint, bigint, timestamptz) owner to postgres;
revoke all on function public.powerhub_dashboard_financial_overview(bigint, bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.powerhub_dashboard_financial_overview(bigint, bigint, timestamptz) to service_role;

-- Support the hottest aggregate paths: open debt by branch/due date and scoped current-period reads.
create index if not exists invoices_dashboard_open_debt_idx
  on public.invoices (tenant_id, site_id, due_date, subscriber_id, id)
  include (invoice_no, balance_due, status)
  where status not in ('cancelled', 'draft') and balance_due > 0;

create index if not exists expenses_tenant_site_occurred_at_id_idx
  on public.expenses (tenant_id, site_id, occurred_at desc, id desc);

