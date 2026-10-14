\set ON_ERROR_STOP on

do $roles$
begin create role anon; exception when duplicate_object then null; end
$roles$;
do $roles$
begin create role authenticated; exception when duplicate_object then null; end
$roles$;
do $roles$
begin create role service_role; exception when duplicate_object then null; end
$roles$;

create table public.powerhub_message_automations (
  id bigint primary key,
  tenant_id bigint not null,
  site_id bigint not null,
  enabled boolean not null default true,
  archived_at timestamptz,
  updated_by bigint,
  updated_at timestamptz not null default now()
);

\ir ../migrations/20261014210000_powerhub_unified_messaging_automation_state_return_fix.sql

insert into public.powerhub_message_automations(id,tenant_id,site_id,enabled)
values (1,10,20,true),(2,10,21,true);

do $test_state$
declare
  v_row record;
  v_caught boolean := false;
begin
  select * into v_row
  from public.powerhub_unified_messaging_set_automation_state(10,20,1,false,false,99);
  if v_row.id <> 1 or v_row.enabled is not false or v_row.archived_at is not null then
    raise exception 'disable automation returned unexpected state: %', row_to_json(v_row);
  end if;

  select * into v_row
  from public.powerhub_unified_messaging_set_automation_state(10,20,1,true,false,99);
  if v_row.enabled is not true or v_row.archived_at is not null then
    raise exception 'enable automation returned unexpected state: %', row_to_json(v_row);
  end if;

  select * into v_row
  from public.powerhub_unified_messaging_set_automation_state(10,20,1,true,true,99);
  if v_row.enabled is not false or v_row.archived_at is null then
    raise exception 'archive automation returned unexpected state: %', row_to_json(v_row);
  end if;

  begin
    perform * from public.powerhub_unified_messaging_set_automation_state(10,20,2,false,false,99);
  exception when others then
    if sqlerrm = 'AUTOMATION_OUT_OF_SCOPE' then v_caught := true; else raise; end if;
  end;
  if not v_caught then
    raise exception 'automation state RPC allowed a cross-site update';
  end if;
end
$test_state$;

\echo 'unified messaging automation state SQL integration assertions passed'
