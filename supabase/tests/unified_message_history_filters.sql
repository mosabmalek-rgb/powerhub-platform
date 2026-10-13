\set ON_ERROR_STOP on
\echo 'Setting up isolated fixtures for unified message history'
create schema if not exists public;

do $roles$
begin
  create role anon;
exception when duplicate_object then null;
end
$roles$;
do $roles$
begin
  create role authenticated;
exception when duplicate_object then null;
end
$roles$;
do $roles$
begin
  create role service_role;
exception when duplicate_object then null;
end
$roles$;

create table public.tenants (id bigint primary key);
create table public.sites (id bigint primary key, tenant_id bigint not null references public.tenants(id));
create table public.subscribers (
  id bigint primary key, tenant_id bigint not null, site_id bigint not null,
  full_name text, subscriber_no text
);
create table public.invoices (
  id bigint primary key, tenant_id bigint not null, site_id bigint not null,
  subscriber_id bigint, invoice_no text
);
create table public.tenant_reading_cycle_configurations (
  tenant_id bigint not null, site_id bigint not null, timezone text
);
create table public.powerhub_message_templates (
  id bigint primary key, tenant_id bigint not null, name text
);
create table public.powerhub_message_automations (
  id bigint primary key, tenant_id bigint not null, site_id bigint, name text
);
create table public.powerhub_message_campaigns (
  id bigint primary key, tenant_id bigint not null, site_id bigint not null,
  template_id bigint not null, status text, created_at timestamptz, updated_at timestamptz,
  requested integer, queued integer, submitted integer, failed integer, skipped integer, completed_at timestamptz
);
create table public.powerhub_message_campaign_recipients (
  id bigint primary key, campaign_id bigint not null, subscriber_id bigint not null,
  notification_id bigint not null, created_at timestamptz
);
create table public.notification_messages (
  id bigint primary key, tenant_id bigint not null, invoice_id bigint, subscriber_id bigint,
  channel text, event_type text, recipient text, status text, provider_message_id text,
  payload jsonb, attempts integer, last_error text, created_at timestamptz, updated_at timestamptz,
  scheduled_at timestamptz, send_type text, schedule_type text, operation_key text,
  template_id bigint, automation_id bigint
);

create or replace function public.powerhub_cycle_for_reading(p_tenant_id bigint, p_site_id bigint, p_reading_at timestamptz)
returns table(cycle_start_at timestamptz, cycle_end_at timestamptz)
language sql stable
as $$
  select now() - interval '30 days', now() + interval '30 days'
  where exists (select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id);
$$;

insert into public.tenants values (1);
insert into public.sites values (10,1),(20,1);
insert into public.subscribers values
  (100,1,10,'مشترك الفرع الأول','SUB-100'),
  (200,1,20,'مشترك الفرع الثاني','SUB-200');
insert into public.invoices values
  (1000,1,10,100,'INV-1000'),
  (2000,1,20,200,'INV-2000');
insert into public.powerhub_message_templates values (11,1,'قالب الحملة');
insert into public.powerhub_message_campaigns values
  (501,1,10,11,'completed',now(),now(),1,1,1,0,0,now());
insert into public.notification_messages values
  (1,1,null,100,'sms','manual','+970599000100','submitted','provider-1','{"renderedText":"رسالة حملة اختبار"}',1,null,now(),now(),null,'manual','none','manual-op-1',11,null),
  (2,1,1000,100,'whatsapp','invoice_issued','+970599000100','failed',null,'{"renderedText":"فاتورتك جاهزة"}',2,'provider rejected',now(),now(),null,'automatic','none',null,11,null),
  (3,1,2000,200,'sms','invoice_issued','+970599000200','submitted','provider-3','{"renderedText":"رسالة من فرع آخر"}',1,null,now(),now(),null,'automatic','none',null,11,null);
insert into public.powerhub_message_campaign_recipients values (1,501,100,1,now());

\echo 'Applying unified history migration'
\ir ../migrations/20261013170000_powerhub_unified_message_history_filters.sql

do $assertions$
declare
  v jsonb;
begin
  v := public.powerhub_unified_messaging_history(1,10,'custom',current_date-1,current_date+1,'all','all','all',null,50,0);
  if (v->>'total')::integer <> 2 then raise exception 'Expected exactly 2 messages for site 10; got %', v->>'total'; end if;
  if (v->>'campaignCount')::integer <> 1 then raise exception 'Expected one distinct campaign; got %', v->>'campaignCount'; end if;
  if jsonb_array_length(v->'items') <> 2 then raise exception 'Page items do not match total'; end if;

  v := public.powerhub_unified_messaging_history(1,10,'custom',current_date-1,current_date+1,'all','sms','all',null,50,0);
  if (v->>'total')::integer <> 1 then raise exception 'SMS channel filter failed'; end if;

  v := public.powerhub_unified_messaging_history(1,10,'custom',current_date-1,current_date+1,'all','all','failed',null,50,0);
  if (v->>'total')::integer <> 1 then raise exception 'Status filter failed'; end if;

  v := public.powerhub_unified_messaging_history(1,10,'custom',current_date-1,current_date+1,'manual','all','all',null,50,0);
  if (v->>'total')::integer <> 1 then raise exception 'Manual source/type filter failed'; end if;

  v := public.powerhub_unified_messaging_history(1,10,'today',null,null,'all','all','all',null,50,0);
  if (v->>'total')::integer <> 2 then raise exception 'Today filter failed'; end if;

  v := public.powerhub_unified_messaging_history(1,10,'cycle',null,null,'all','all','all',null,50,0);
  if (v->>'total')::integer <> 2 then raise exception 'Canonical cycle filter failed'; end if;

  v := public.powerhub_unified_messaging_history(1,20,'custom',current_date-1,current_date+1,'all','all','all',null,50,0);
  if (v->>'total')::integer <> 1 then raise exception 'Site isolation failed for second site'; end if;

  if has_function_privilege('authenticated',
      'public.powerhub_unified_messaging_history(bigint,bigint,text,date,date,text,text,text,text,integer,integer)', 'EXECUTE') then
    raise exception 'authenticated must not execute the privileged history RPC directly';
  end if;
  if not has_function_privilege('service_role',
      'public.powerhub_unified_messaging_history(bigint,bigint,text,date,date,text,text,text,text,integer,integer)', 'EXECUTE') then
    raise exception 'service_role must execute the history RPC';
  end if;
end
$assertions$;

\echo 'unified-message-history SQL integration assertions passed'
