\set ON_ERROR_STOP on
select 'create role anon nologin' where not exists (select 1 from pg_roles where rolname='anon') \gexec
select 'create role authenticated nologin' where not exists (select 1 from pg_roles where rolname='authenticated') \gexec
select 'create role service_role nologin bypassrls' where not exists (select 1 from pg_roles where rolname='service_role') \gexec

create table public.sites(id bigint primary key, tenant_id bigint not null, name text not null, status text not null);
create table public.subscribers(id bigint primary key, tenant_id bigint not null, site_id bigint not null, full_name text not null, subscriber_no text not null, service_status text not null, archived_at timestamptz);
create table public.generators(id bigint primary key, tenant_id bigint not null, site_id bigint not null, status text not null);
create table public.invoices(id bigint primary key, tenant_id bigint not null, site_id bigint not null, subscriber_id bigint not null, invoice_no text not null, issue_date timestamptz not null, due_date timestamptz not null, total_amount numeric not null, paid_amount numeric not null, balance_due numeric not null, consumption_kwh numeric not null, status text not null);
create table public.payments(id bigint primary key, tenant_id bigint not null, site_id bigint not null, subscriber_id bigint not null, amount numeric not null, status text not null, paid_at timestamptz not null);
create table public.expenses(id bigint primary key, tenant_id bigint not null, site_id bigint not null, amount numeric not null, occurred_at timestamptz not null);
create table public.notification_messages(id bigint primary key, tenant_id bigint not null, subscriber_id bigint not null, status text not null);

insert into public.sites values (10,1,'الفرع الرئيسي','active'),(11,1,'فرع السوق','inactive'),(12,1,'فرع مؤرشف','archived'),(20,2,'مستأجر آخر','active');
insert into public.subscribers values
(100,1,10,'أحمد','A-100','active',null),(101,1,11,'سارة','A-101','active',null),
(102,1,10,'علي','A-102','inactive',null),(103,1,10,'مشترك مؤرشف','A-103','active','2026-10-01T00:00:00Z'),(200,2,20,'مستأجر آخر','B-200','active',null);
insert into public.generators values (1,1,10,'active'),(2,1,11,'maintenance'),(3,1,12,'active'),(4,2,20,'active');
insert into public.invoices values
(1,1,10,100,'INV-1','2026-10-26T08:00:00Z','2026-10-10T00:00:00Z',100,30,70,10,'issued'),
(2,1,11,101,'INV-2','2026-10-05T08:00:00Z','2026-11-01T00:00:00Z',80,0,80,8,'issued'),
(3,1,10,102,'INV-3','2026-10-20T08:00:00Z','2026-10-25T00:00:00Z',50,20,30,5,'partially_paid'),
(4,1,10,100,'INV-4','2026-10-21T08:00:00Z','2026-10-22T00:00:00Z',25,25,0,2,'paid'),
(5,1,10,100,'INV-CANCELLED','2026-10-22T08:00:00Z','2026-11-02T00:00:00Z',500,0,0,0,'cancelled'),
(6,1,10,100,'INV-DRAFT','2026-10-23T08:00:00Z','2026-11-03T00:00:00Z',600,0,0,0,'draft'),
(7,2,20,200,'INV-OTHER','2026-10-26T08:00:00Z','2026-10-10T00:00:00Z',999,0,999,99,'issued');
insert into public.payments values
(1,1,10,100,30,'completed','2026-10-26T10:00:00Z'),(2,1,11,101,20,'completed','2026-10-10T10:00:00Z'),
(3,1,10,100,999,'pending','2026-10-26T11:00:00Z'),(4,2,20,200,999,'completed','2026-10-26T10:00:00Z');
insert into public.expenses values
(1,1,10,10,'2026-10-12T10:00:00Z'),(2,1,11,5,'2026-10-26T10:00:00Z'),
(3,1,10,1000,'2025-10-26T10:00:00Z'),(4,2,20,999,'2026-10-26T10:00:00Z');
insert into public.notification_messages values (1,1,100,'failed'),(2,1,103,'failed'),(3,2,200,'failed');

\ir ../migrations/20261026133000_powerhub_dashboard_database_aggregates.sql

do $test$
declare op jsonb; branch_op jsonb; fin jsonb;
begin
  op := public.powerhub_dashboard_operational_summary(1,null);
  if (op->>'branchCount')::integer<>2 or (op->>'subscribers')::integer<>2
    or (op->'generators'->>'active')::integer<>1 or (op->'generators'->>'maintenance')::integer<>1
    or (op->'financial'->>'invoiced')::numeric<>255 or (op->'financial'->>'collected')::numeric<>75
    or (op->'financial'->>'outstanding')::numeric<>180 or (op->'financial'->>'expenses')::numeric<>1015
    or (op->'financial'->>'operatingProfit')::numeric<>-940 or (op->>'energyKwh')::numeric<>25
    or (op->>'failedNotifications')::integer<>1 then raise exception 'operational aggregate mismatch: %',op; end if;
  branch_op := public.powerhub_dashboard_operational_summary(1,10);
  if (branch_op->>'branchCount')::integer<>1 or (branch_op->>'subscribers')::integer<>1
    or (branch_op->'financial'->>'invoiced')::numeric<>255-80 then raise exception 'branch aggregate mismatch: %',branch_op; end if;
  fin := public.powerhub_dashboard_financial_overview(1,null,'2026-10-26T12:00:00Z');
  if (fin->'today'->>'invoiced')::numeric<>100 or (fin->'today'->>'collected')::numeric<>30
    or (fin->'month'->>'invoiced')::numeric<>255 or (fin->'month'->>'collected')::numeric<>50
    or (fin->'month'->>'expenses')::numeric<>15 or (fin->'month'->>'netCash')::numeric<>35
    or (fin->'outstanding'->>'total')::numeric<>180 or (fin->'outstanding'->>'overdue')::numeric<>100
    or (fin->'outstanding'->>'partialInvoices')::integer<>1 or (fin->'outstanding'->>'accountCount')::integer<>3
    or jsonb_array_length(fin->'branchSummaries')<>2 or jsonb_array_length(fin->'topDebtors')<>3
    or jsonb_array_length(fin->'outstandingInvoices')<>3 or jsonb_array_length(fin->'trend')<>31
    then raise exception 'financial aggregate mismatch: %',fin; end if;
  if fin->'branchSummaries'->0->>'name'<>'الفرع الرئيسي'
    or (fin->'branchSummaries'->0->>'activeSubscribers')::integer<>1
    or (fin->'branchSummaries'->0->>'outstanding')::numeric<>100
    or fin->'topDebtors'->0->>'subscriberNo'<>'A-100'
    or (fin->'topDebtors'->0->>'outstanding')::numeric<>70
    or fin->'topDebtors'->0->>'lastPaymentAt'<>'2026-10-26T10:00:00.000Z'
    then raise exception 'financial detail mismatch: %',fin; end if;
  if has_function_privilege('anon','public.powerhub_dashboard_operational_summary(bigint,bigint)','EXECUTE')
    or has_function_privilege('authenticated','public.powerhub_dashboard_operational_summary(bigint,bigint)','EXECUTE')
    or not has_function_privilege('service_role','public.powerhub_dashboard_operational_summary(bigint,bigint)','EXECUTE')
    then raise exception 'operational RPC grants are incorrect'; end if;
  if has_function_privilege('anon','public.powerhub_dashboard_financial_overview(bigint,bigint,timestamp with time zone)','EXECUTE')
    or has_function_privilege('authenticated','public.powerhub_dashboard_financial_overview(bigint,bigint,timestamp with time zone)','EXECUTE')
    or not has_function_privilege('service_role','public.powerhub_dashboard_financial_overview(bigint,bigint,timestamp with time zone)','EXECUTE')
    then raise exception 'financial RPC grants are incorrect'; end if;
end
$test$;
\echo 'dashboard financial aggregate SQL integration assertions passed'
