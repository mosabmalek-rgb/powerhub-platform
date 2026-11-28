\set ON_ERROR_STOP on
select 'create role anon nologin' where not exists (select 1 from pg_roles where rolname='anon') \gexec
select 'create role authenticated nologin' where not exists (select 1 from pg_roles where rolname='authenticated') \gexec
select 'create role service_role nologin bypassrls' where not exists (select 1 from pg_roles where rolname='service_role') \gexec

create table public.sites(id bigint,tenant_id bigint,status text);
create table public.inventory_stock_movements(
  tenant_id bigint,site_id bigint,warehouse_id bigint,item_id bigint,
  movement_type text,quantity numeric,total_cost_amount numeric
);
create table public.subscriber_balance_ledger(
  tenant_id bigint,site_id bigint,subscriber_id bigint,balance_type text,direction text,amount numeric
);
create table public.payroll_runs(tenant_id bigint,site_id bigint,status text,total_net numeric);
create function public.powerhub_financial_current_position(p_tenant_id bigint,p_site_id bigint)
returns jsonb language sql stable as $$select jsonb_build_object('scopeSiteId',p_site_id,'cashBalance',100)$$;

\ir ../migrations/20261109160000_financial_current_position_assets_liabilities.sql

insert into public.sites values (10,1,'active'),(11,1,'active'),(20,2,'active');
insert into public.inventory_stock_movements values
  (1,10,1,1,'opening_balance',10,100),
  (1,10,1,1,'purchase_receipt',5,50),
  (1,10,1,1,'issue',2,20),
  (1,10,1,1,'issue',3,30),
  (1,10,2,1,'adjustment_in',3,30),
  (1,10,1,1,'return_from_issue',1,10),
  (1,11,3,1,'opening_balance',100,999),
  (2,20,4,1,'opening_balance',100,888);
insert into public.subscriber_balance_ledger values
  (1,10,100,'available_credit','credit',40),
  (1,10,100,'available_credit','debit',15),
  (1,10,100,'security_deposit','credit',100),
  (1,10,100,'security_deposit','debit',20),
  (1,11,101,'security_deposit','credit',999),
  (2,20,200,'available_credit','credit',888);
insert into public.payroll_runs values
  (1,10,'approved',60),(1,10,'draft',70),(1,10,'paid',80),
  (1,11,'approved',90),(2,20,'approved',888);

do $test$
declare position jsonb;
begin
  position:=public.powerhub_financial_current_position_v2(1,10);
  if (position->>'inventoryValue')::numeric<>140
     or (position->>'subscriberCreditLiability')::numeric<>25
     or (position->>'securityDepositLiability')::numeric<>80
     or (position->>'approvedPayrollPayable')::numeric<>60
     or (position->>'inventoryValuationIssueCount')::integer<>0
     or (position->>'cashBalance')::numeric<>100 then
    raise exception 'current-position asset/liability mismatch: %',position;
  end if;
  if public.powerhub_financial_current_position_v2(1,20) is not null then
    raise exception 'cross-tenant site produced a financial position';
  end if;
  if has_function_privilege('anon','public.powerhub_financial_current_position_v2(bigint,bigint)','EXECUTE')
     or has_function_privilege('authenticated','public.powerhub_financial_current_position_v2(bigint,bigint)','EXECUTE')
     or not has_function_privilege('service_role','public.powerhub_financial_current_position_v2(bigint,bigint)','EXECUTE') then
    raise exception 'financial position RPC grants are incorrect';
  end if;
  insert into public.inventory_stock_movements values (1,10,1,1,'issue',100,1000);
  position:=public.powerhub_financial_current_position_v2(1,10);
  if position->'inventoryValue'<>'null'::jsonb
     or (position->>'inventoryValuationIssueCount')::integer<>1 then
    raise exception 'negative inventory valuation did not fail closed: %',position;
  end if;
end $test$;
\echo 'financial current-position asset/liability integration assertions passed'
