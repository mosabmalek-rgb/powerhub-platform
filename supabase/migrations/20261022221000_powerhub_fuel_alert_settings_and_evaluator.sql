-- Phase B fuel alert settings, episode ledger, idempotent in-app delivery and evaluator.
-- The existing protected PowerHub scheduler invokes the evaluator as a periodic backstop;
-- inserts into readings and fuel events invoke the same evaluator transactionally.

create table if not exists public.generator_fuel_alert_settings (
  id bigint generated always as identity primary key,
  tenant_id bigint not null,
  site_id bigint not null,
  generator_id bigint not null,
  tank_warehouse_id bigint not null,
  low_level_threshold_liters numeric(14,3),
  abnormal_litres_per_hour_threshold numeric(14,3),
  minimum_hours_delta numeric(14,3) not null default 1,
  is_enabled boolean not null default true,
  updated_by_user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,site_id,id),
  constraint generator_fuel_alert_settings_scope_unique unique (tenant_id,site_id,generator_id,tank_warehouse_id),
  constraint generator_fuel_alert_settings_site_fk
    foreign key (tenant_id,site_id) references public.sites(tenant_id,id) on delete restrict,
  constraint generator_fuel_alert_settings_generator_fk
    foreign key (tenant_id,site_id,generator_id) references public.generators(tenant_id,site_id,id) on delete restrict,
  constraint generator_fuel_alert_settings_tank_fk
    foreign key (tenant_id,site_id,tank_warehouse_id) references public.inventory_warehouses(tenant_id,site_id,id) on delete restrict,
  constraint generator_fuel_alert_settings_low_ck
    check (low_level_threshold_liters is null or low_level_threshold_liters between 0 and 1000000000),
  constraint generator_fuel_alert_settings_rate_ck
    check (abnormal_litres_per_hour_threshold is null or abnormal_litres_per_hour_threshold between 0.001 and 1000000000),
  constraint generator_fuel_alert_settings_hours_ck
    check (minimum_hours_delta between 0.001 and 1000000),
  constraint generator_fuel_alert_settings_enabled_ck
    check (not is_enabled or low_level_threshold_liters is not null or abnormal_litres_per_hour_threshold is not null)
);

create index if not exists generator_fuel_alert_settings_active_idx
  on public.generator_fuel_alert_settings(tenant_id,site_id,id)
  where is_enabled and (low_level_threshold_liters is not null or abnormal_litres_per_hour_threshold is not null);

create table if not exists public.generator_fuel_alert_setting_operations (
  id bigint generated always as identity primary key,
  tenant_id bigint not null,
  site_id bigint not null,
  operation_key text not null check (length(trim(operation_key)) between 1 and 180),
  payload_hash text not null,
  settings_id bigint not null,
  created_by_user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id,site_id,operation_key),
  foreign key (tenant_id,site_id,settings_id)
    references public.generator_fuel_alert_settings(tenant_id,site_id,id) on delete restrict
);

create table if not exists public.powerhub_fuel_alert_states (
  tenant_id bigint not null,
  site_id bigint not null,
  setting_id bigint not null,
  alert_type text not null check (alert_type in ('low_fuel_level','abnormal_consumption')),
  is_active boolean not null default false,
  episode_no bigint not null default 0 check (episode_no >= 0),
  last_signal_key text,
  last_evaluated_at timestamptz,
  last_triggered_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id,site_id,setting_id,alert_type),
  foreign key (tenant_id,site_id,setting_id)
    references public.generator_fuel_alert_settings(tenant_id,site_id,id) on delete restrict
);
create index if not exists powerhub_fuel_alert_states_active_idx
  on public.powerhub_fuel_alert_states(tenant_id,site_id,updated_at desc)
  where is_active;

create table if not exists public.powerhub_fuel_alert_dispatches (
  id bigint generated always as identity primary key,
  tenant_id bigint not null,
  site_id bigint not null,
  setting_id bigint not null,
  alert_type text not null check (alert_type in ('low_fuel_level','abnormal_consumption')),
  episode_no bigint not null check (episode_no > 0),
  signal_key text not null,
  dedupe_key text not null,
  measured_value numeric(14,3) not null,
  threshold_value numeric(14,3) not null,
  recipient_count integer not null default 0 check (recipient_count >= 0),
  created_at timestamptz not null default now(),
  unique (tenant_id,site_id,setting_id,alert_type,episode_no),
  unique (tenant_id,dedupe_key),
  foreign key (tenant_id,site_id,setting_id)
    references public.generator_fuel_alert_settings(tenant_id,site_id,id) on delete restrict
);
create index if not exists powerhub_fuel_alert_dispatches_recent_idx
  on public.powerhub_fuel_alert_dispatches(tenant_id,site_id,created_at desc,id desc);
create index if not exists powerhub_fuel_alert_dispatches_setting_idx
  on public.powerhub_fuel_alert_dispatches(tenant_id,site_id,setting_id,created_at desc,id desc);

alter table public.generator_fuel_alert_settings enable row level security;
alter table public.generator_fuel_alert_setting_operations enable row level security;
alter table public.powerhub_fuel_alert_states enable row level security;
alter table public.powerhub_fuel_alert_dispatches enable row level security;
revoke all privileges on table public.generator_fuel_alert_settings,
  public.generator_fuel_alert_setting_operations,public.powerhub_fuel_alert_states,
  public.powerhub_fuel_alert_dispatches from public,anon,authenticated,service_role;
grant select on table public.generator_fuel_alert_settings,
  public.generator_fuel_alert_setting_operations,public.powerhub_fuel_alert_states,
  public.powerhub_fuel_alert_dispatches to service_role;
revoke all privileges on sequence public.generator_fuel_alert_settings_id_seq,
  public.generator_fuel_alert_setting_operations_id_seq,public.powerhub_fuel_alert_dispatches_id_seq
  from public,anon,authenticated,service_role;

create or replace function public.powerhub_inventory_upsert_fuel_alert_settings(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_generator_id bigint,p_tank_warehouse_id bigint,
  p_low_level_threshold_liters numeric,p_abnormal_litres_per_hour_threshold numeric,
  p_minimum_hours_delta numeric,p_is_enabled boolean,p_operation_key text
)
returns table(
  setting_id bigint,generator_id bigint,tank_warehouse_id bigint,
  low_level_threshold_liters numeric,abnormal_litres_per_hour_threshold numeric,
  minimum_hours_delta numeric,is_enabled boolean,updated_at timestamptz,replayed boolean
)
language plpgsql security definer set search_path=public,pg_temp
as $function$
declare
  v_setting public.generator_fuel_alert_settings%rowtype;
  v_before jsonb;
  v_payload_hash text;
  v_prior_hash text;
  v_prior_setting_id bigint;
begin
  if p_tenant_id is null or p_site_id is null or p_user_id is null
    or p_generator_id is null or p_tank_warehouse_id is null
    or p_minimum_hours_delta is null or p_minimum_hours_delta<=0 or p_minimum_hours_delta>1000000
    or (p_low_level_threshold_liters is not null and (p_low_level_threshold_liters<0 or p_low_level_threshold_liters>1000000000))
    or (p_abnormal_litres_per_hour_threshold is not null and (p_abnormal_litres_per_hour_threshold<0.001 or p_abnormal_litres_per_hour_threshold>1000000000))
    or coalesce(p_is_enabled,false) and p_low_level_threshold_liters is null and p_abnormal_litres_per_hour_threshold is null
    or p_operation_key is null or length(trim(p_operation_key)) not between 1 and 180 then
    raise exception 'INVALID_FUEL_ALERT_SETTINGS' using errcode='P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_site_id::text||':fuel-alert:'||trim(p_operation_key),0));
  v_payload_hash:=md5(jsonb_build_object(
    'generatorId',p_generator_id,'tankWarehouseId',p_tank_warehouse_id,
    'lowLevel',p_low_level_threshold_liters,'litresPerHour',p_abnormal_litres_per_hour_threshold,
    'minimumHours',p_minimum_hours_delta,'enabled',p_is_enabled
  )::text);

  select o.payload_hash,o.settings_id into v_prior_hash,v_prior_setting_id
  from public.generator_fuel_alert_setting_operations o
  where o.tenant_id=p_tenant_id and o.site_id=p_site_id and o.operation_key=trim(p_operation_key);
  if found then
    if v_prior_hash is distinct from v_payload_hash then
      raise exception 'FUEL_ALERT_IDEMPOTENCY_KEY_REUSED' using errcode='P0001';
    end if;
    select * into v_setting from public.generator_fuel_alert_settings s
    where s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.id=v_prior_setting_id;
    if not found then raise exception 'FUEL_ALERT_SETTING_NOT_FOUND' using errcode='P0001'; end if;
    return query select v_setting.id,v_setting.generator_id,v_setting.tank_warehouse_id,
      v_setting.low_level_threshold_liters,v_setting.abnormal_litres_per_hour_threshold,
      v_setting.minimum_hours_delta,v_setting.is_enabled,v_setting.updated_at,true;
    return;
  end if;

  if not exists(select 1 from public.generators g
    where g.tenant_id=p_tenant_id and g.site_id=p_site_id and g.id=p_generator_id) then
    raise exception 'FUEL_GENERATOR_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if not exists(select 1 from public.inventory_warehouses w
    where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=p_tank_warehouse_id
      and w.location_type='generator_fuel_tank' and w.generator_id=p_generator_id and w.is_active) then
    raise exception 'FUEL_TANK_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  select to_jsonb(s) into v_before from public.generator_fuel_alert_settings s
  where s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.generator_id=p_generator_id
    and s.tank_warehouse_id=p_tank_warehouse_id;
  insert into public.generator_fuel_alert_settings(
    tenant_id,site_id,generator_id,tank_warehouse_id,low_level_threshold_liters,
    abnormal_litres_per_hour_threshold,minimum_hours_delta,is_enabled,updated_by_user_id,updated_at
  ) values(
    p_tenant_id,p_site_id,p_generator_id,p_tank_warehouse_id,p_low_level_threshold_liters,
    p_abnormal_litres_per_hour_threshold,p_minimum_hours_delta,p_is_enabled,p_user_id,now()
  )
  on conflict on constraint generator_fuel_alert_settings_scope_unique do update set
    low_level_threshold_liters=excluded.low_level_threshold_liters,
    abnormal_litres_per_hour_threshold=excluded.abnormal_litres_per_hour_threshold,
    minimum_hours_delta=excluded.minimum_hours_delta,is_enabled=excluded.is_enabled,
    updated_by_user_id=excluded.updated_by_user_id,updated_at=now()
  returning * into v_setting;

  insert into public.generator_fuel_alert_setting_operations(
    tenant_id,site_id,operation_key,payload_hash,settings_id,created_by_user_id
  ) values(p_tenant_id,p_site_id,trim(p_operation_key),v_payload_hash,v_setting.id,p_user_id);

  if not v_setting.is_enabled then
    update public.powerhub_fuel_alert_states st set is_active=false,last_evaluated_at=now(),updated_at=now()
    where st.tenant_id=p_tenant_id and st.site_id=p_site_id and st.setting_id=v_setting.id;
  end if;

  insert into public.audit_logs(tenant_id,site_id,user_id,entity_type,entity_id,action,before_data,after_data,metadata)
  values(p_tenant_id,p_site_id,p_user_id,'generator_fuel_alert_setting',v_setting.id::text,'configure',
    v_before,to_jsonb(v_setting),jsonb_build_object('operationKey',trim(p_operation_key)));

  perform * from public.powerhub_inventory_evaluate_fuel_alerts(p_tenant_id,p_site_id);
  return query select v_setting.id,v_setting.generator_id,v_setting.tank_warehouse_id,
    v_setting.low_level_threshold_liters,v_setting.abnormal_litres_per_hour_threshold,
    v_setting.minimum_hours_delta,v_setting.is_enabled,v_setting.updated_at,false;
end;
$function$;

create or replace function public.powerhub_inventory_list_fuel_alert_settings(p_tenant_id bigint,p_site_id bigint)
returns table(
  setting_id bigint,generator_id bigint,generator_name text,tank_warehouse_id bigint,tank_name text,
  low_level_threshold_liters numeric,abnormal_litres_per_hour_threshold numeric,minimum_hours_delta numeric,
  is_enabled boolean,updated_at timestamptz,low_level_alert_active boolean,low_level_last_triggered_at timestamptz,
  abnormal_alert_active boolean,abnormal_last_triggered_at timestamptz
)
language sql stable security definer set search_path=public,pg_temp
as $function$
  select s.id,s.generator_id,g.name,s.tank_warehouse_id,w.name,s.low_level_threshold_liters,
    s.abnormal_litres_per_hour_threshold,s.minimum_hours_delta,s.is_enabled,s.updated_at,
    coalesce(l.is_active,false),l.last_triggered_at,coalesce(a.is_active,false),a.last_triggered_at
  from public.generator_fuel_alert_settings s
  join public.generators g on g.tenant_id=s.tenant_id and g.site_id=s.site_id and g.id=s.generator_id
  join public.inventory_warehouses w on w.tenant_id=s.tenant_id and w.site_id=s.site_id and w.id=s.tank_warehouse_id
  left join public.powerhub_fuel_alert_states l on l.tenant_id=s.tenant_id and l.site_id=s.site_id and l.setting_id=s.id and l.alert_type='low_fuel_level'
  left join public.powerhub_fuel_alert_states a on a.tenant_id=s.tenant_id and a.site_id=s.site_id and a.setting_id=s.id and a.alert_type='abnormal_consumption'
  where s.tenant_id=p_tenant_id and s.site_id=p_site_id order by g.name,w.name,s.id;
$function$;

create or replace function public.powerhub_inventory_list_fuel_alert_dispatches(
  p_tenant_id bigint,p_site_id bigint,p_from_date date default null,p_to_date date default null,
  p_generator_id bigint default null,p_tank_warehouse_id bigint default null,p_limit integer default 100
)
returns table(
  dispatch_id bigint,setting_id bigint,alert_type text,episode_no bigint,generator_id bigint,generator_name text,
  tank_warehouse_id bigint,tank_name text,signal_key text,measured_value numeric,threshold_value numeric,
  recipient_count integer,created_at timestamptz
)
language sql stable security definer set search_path=public,pg_temp
as $function$
  select d.id,d.setting_id,d.alert_type,d.episode_no,s.generator_id,g.name,s.tank_warehouse_id,w.name,
    d.signal_key,d.measured_value,d.threshold_value,d.recipient_count,d.created_at
  from public.powerhub_fuel_alert_dispatches d
  join public.generator_fuel_alert_settings s on s.tenant_id=d.tenant_id and s.site_id=d.site_id and s.id=d.setting_id
  join public.generators g on g.tenant_id=s.tenant_id and g.site_id=s.site_id and g.id=s.generator_id
  join public.inventory_warehouses w on w.tenant_id=s.tenant_id and w.site_id=s.site_id and w.id=s.tank_warehouse_id
  where d.tenant_id=p_tenant_id and d.site_id=p_site_id
    and (p_from_date is null or d.created_at >= p_from_date::timestamptz)
    and (p_to_date is null or d.created_at < (p_to_date+1)::timestamptz)
    and (p_generator_id is null or s.generator_id=p_generator_id)
    and (p_tank_warehouse_id is null or s.tank_warehouse_id=p_tank_warehouse_id)
  order by d.created_at desc,d.id desc limit greatest(1,least(coalesce(p_limit,100),500));
$function$;

create or replace function public.powerhub_inventory_evaluate_fuel_alerts(p_tenant_id bigint default null,p_site_id bigint default null)
returns table(evaluated_settings integer,low_level_alerts integer,abnormal_consumption_alerts integer,notifications_created integer)
language plpgsql security definer set search_path=public,pg_temp
as $function$
declare
  s record; st public.powerhub_fuel_alert_states%rowtype; owner_id bigint; notification_rows integer;
  latest_level record; previous_hours record; latest_hours record; level_start record; level_end record; measured record;
  low_value numeric; low_signal text; rate_value numeric; rate_signal text; rate_valid boolean;
  condition_active boolean; active_episode bigint; dedupe text; dispatch_id bigint;
  n_settings integer:=0; n_low integer:=0; n_rate integer:=0; n_notifications integer:=0;
begin
  if p_site_id is not null and p_tenant_id is null then
    raise exception 'FUEL_ALERT_SITE_REQUIRES_TENANT' using errcode='P0001';
  end if;

  for s in
    select x.*,g.name generator_name,w.name tank_name
    from public.generator_fuel_alert_settings x
    join public.generators g on g.tenant_id=x.tenant_id and g.site_id=x.site_id and g.id=x.generator_id
    join public.inventory_warehouses w on w.tenant_id=x.tenant_id and w.site_id=x.site_id and w.id=x.tank_warehouse_id
    where x.is_enabled and (x.low_level_threshold_liters is not null or x.abnormal_litres_per_hour_threshold is not null)
      and (p_tenant_id is null or x.tenant_id=p_tenant_id)
      and (p_site_id is null or x.site_id=p_site_id)
    order by x.tenant_id,x.site_id,x.id
    for update of x skip locked
  loop
    n_settings:=n_settings+1;
    low_value:=null; low_signal:=null;
    select point_key,point_value into low_signal,low_value
    from (
      select 'reading:'||r.id::text point_key,r.reading_value point_value,r.recorded_at point_at,0 priority,r.id point_id
      from public.generator_fuel_readings r
      where r.tenant_id=s.tenant_id and r.site_id=s.site_id and r.generator_id=s.generator_id
        and r.reading_type='tank_level' and r.tank_warehouse_id=s.tank_warehouse_id
        and not exists(select 1 from public.generator_fuel_readings c where c.tenant_id=r.tenant_id and c.corrects_reading_id=r.id)
      union all
      select 'fill:'||e.id::text,e.level_after_liters,e.occurred_at,1,e.id
      from public.generator_fuel_events e
      where e.tenant_id=s.tenant_id and e.site_id=s.site_id and e.generator_id=s.generator_id
        and e.destination_warehouse_id=s.tank_warehouse_id and e.level_after_liters is not null
    ) p where p.point_value is not null
    order by p.point_at desc,p.priority desc,p.point_id desc limit 1;

    insert into public.powerhub_fuel_alert_states(tenant_id,site_id,setting_id,alert_type)
    values(s.tenant_id,s.site_id,s.id,'low_fuel_level') on conflict do nothing;
    select * into st from public.powerhub_fuel_alert_states q
    where q.tenant_id=s.tenant_id and q.site_id=s.site_id and q.setting_id=s.id and q.alert_type='low_fuel_level' for update;

    condition_active:=s.low_level_threshold_liters is not null and low_value is not null and low_value<=s.low_level_threshold_liters;
    if condition_active then
      if not st.is_active then
        select o.owner_user_id into owner_id
        from public.tenant_owner_profiles o join public.users u on u.id=o.owner_user_id
        where o.tenant_id=s.tenant_id and o.owner_user_id is not null and u.account_status='active'
        order by o.id limit 1;
        if owner_id is not null then
          active_episode:=st.episode_no+1;
          dedupe:='fuel-alert:'||s.id::text||':low_fuel_level:'||active_episode::text;
          insert into public.powerhub_fuel_alert_dispatches(
            tenant_id,site_id,setting_id,alert_type,episode_no,signal_key,dedupe_key,measured_value,threshold_value,recipient_count
          ) values(s.tenant_id,s.site_id,s.id,'low_fuel_level',active_episode,coalesce(low_signal,'unknown'),dedupe,low_value,s.low_level_threshold_liters,0)
          returning id into dispatch_id;
          insert into public.powerhub_user_notifications(
            user_id,tenant_id,notification_type,title,body,target_path,entity_type,entity_id,dedupe_key,metadata
          ) values(owner_id,s.tenant_id,'system_alert','تنبيه مستوى وقود منخفض',
            'المولد '||s.generator_name||' ('||s.tank_name||'): المستوى الحالي '||low_value::text
              ||' لتر، والحد المحدد '||s.low_level_threshold_liters::text||' لتر.',
            '/inventory?tab=fuel','generator_fuel_alert',s.id::text,dedupe,
            jsonb_build_object('alert_type','low_fuel_level','setting_id',s.id,'generator_id',s.generator_id,
              'tank_warehouse_id',s.tank_warehouse_id,'measured_value',low_value,'threshold_value',s.low_level_threshold_liters,
              'episode_no',active_episode,'signal_key',low_signal))
          on conflict(user_id,dedupe_key) do nothing;
          get diagnostics notification_rows=row_count;
          update public.powerhub_fuel_alert_dispatches d set recipient_count=notification_rows where d.id=dispatch_id;
          update public.powerhub_fuel_alert_states q set is_active=true,episode_no=active_episode,last_signal_key=low_signal,
            last_evaluated_at=now(),last_triggered_at=now(),updated_at=now()
          where q.tenant_id=s.tenant_id and q.site_id=s.site_id and q.setting_id=s.id and q.alert_type='low_fuel_level';
          n_low:=n_low+1; n_notifications:=n_notifications+notification_rows;
        else
          update public.powerhub_fuel_alert_states q set last_evaluated_at=now(),last_signal_key=low_signal,updated_at=now()
          where q.tenant_id=s.tenant_id and q.site_id=s.site_id and q.setting_id=s.id and q.alert_type='low_fuel_level';
        end if;
      else
        update public.powerhub_fuel_alert_states q set last_evaluated_at=now(),last_signal_key=low_signal,updated_at=now()
        where q.tenant_id=s.tenant_id and q.site_id=s.site_id and q.setting_id=s.id and q.alert_type='low_fuel_level';
      end if;
    elsif low_value is not null and (s.low_level_threshold_liters is null or low_value>s.low_level_threshold_liters) then
      update public.powerhub_fuel_alert_states q set is_active=false,last_evaluated_at=now(),last_signal_key=low_signal,updated_at=now()
      where q.tenant_id=s.tenant_id and q.site_id=s.site_id and q.setting_id=s.id and q.alert_type='low_fuel_level';
    end if;

    -- Do not treat a single hour reading, a corrected-away row, a negative/zero hour delta,
    -- a missing end-level reading, or an unexplained stock adjustment as measured consumption.
    rate_valid:=false; rate_value:=null; rate_signal:=null;
    rate_valid:=false; rate_value:=null; rate_signal:=null;
    select r.id,r.reading_value,r.recorded_at into latest_hours
    from public.generator_fuel_readings r
    where r.tenant_id=s.tenant_id and r.site_id=s.site_id and r.generator_id=s.generator_id
      and r.reading_type='operating_hours'
      and not exists(select 1 from public.generator_fuel_readings c where c.tenant_id=r.tenant_id and c.corrects_reading_id=r.id)
    order by r.recorded_at desc,r.id desc limit 1;

    if latest_hours.id is not null then
      select r.id,r.reading_value,r.recorded_at into previous_hours
      from public.generator_fuel_readings r
      where r.tenant_id=s.tenant_id and r.site_id=s.site_id and r.generator_id=s.generator_id
        and r.reading_type='operating_hours'
        and (r.recorded_at,r.id)<(latest_hours.recorded_at,latest_hours.id)
        and not exists(select 1 from public.generator_fuel_readings c where c.tenant_id=r.tenant_id and c.corrects_reading_id=r.id)
      order by r.recorded_at desc,r.id desc limit 1;
    end if;

    if previous_hours.id is not null and latest_hours.id is not null
       and latest_hours.recorded_at>previous_hours.recorded_at
       and latest_hours.reading_value-previous_hours.reading_value>=s.minimum_hours_delta then
      select r.id,r.reading_value,r.recorded_at into level_start
      from public.generator_fuel_readings r
      where r.tenant_id=s.tenant_id and r.site_id=s.site_id and r.generator_id=s.generator_id
        and r.reading_type='tank_level' and r.tank_warehouse_id=s.tank_warehouse_id
        and r.recorded_at<=previous_hours.recorded_at
        and not exists(select 1 from public.generator_fuel_readings c where c.tenant_id=r.tenant_id and c.corrects_reading_id=r.id)
      order by r.recorded_at desc,r.id desc limit 1;

      -- Require a level observation at or after the ending hour-meter timestamp to avoid
      -- dispatching an alert from a half-written pair of field readings.
      select r.id,r.reading_value,r.recorded_at into level_end
      from public.generator_fuel_readings r
      where r.tenant_id=s.tenant_id and r.site_id=s.site_id and r.generator_id=s.generator_id
        and r.reading_type='tank_level' and r.tank_warehouse_id=s.tank_warehouse_id
        and r.recorded_at>=latest_hours.recorded_at
        and not exists(select 1 from public.generator_fuel_readings c where c.tenant_id=r.tenant_id and c.corrects_reading_id=r.id)
      order by r.recorded_at asc,r.id asc limit 1;

      if level_start.id is not null and level_end.id is not null then
        select r.* into measured
        from public.powerhub_inventory_fuel_consumption_report_window(
          s.tenant_id,s.site_id,previous_hours.recorded_at+interval '1 microsecond',
          level_end.recorded_at+interval '1 microsecond',s.generator_id,s.tank_warehouse_id
        ) r limit 1;
        if measured.generator_id is not null
           and measured.measurement_status in ('measured','measured_without_hour_rate')
           and measured.actual_consumption_liters is not null
           and measured.operating_hours_delta>=s.minimum_hours_delta
           and measured.operating_hours_delta>0 then
          rate_value:=round(measured.actual_consumption_liters/measured.operating_hours_delta,3);
          rate_signal:='hours:'||previous_hours.id::text||':'||latest_hours.id::text
            ||':levels:'||level_start.id::text||':'||level_end.id::text;
          rate_valid:=true;
        end if;
      end if;
    end if;

    insert into public.powerhub_fuel_alert_states(tenant_id,site_id,setting_id,alert_type)
    values(s.tenant_id,s.site_id,s.id,'abnormal_consumption') on conflict do nothing;
    select * into st from public.powerhub_fuel_alert_states q
    where q.tenant_id=s.tenant_id and q.site_id=s.site_id and q.setting_id=s.id and q.alert_type='abnormal_consumption' for update;
    condition_active:=s.abnormal_litres_per_hour_threshold is not null and rate_valid
      and rate_value>s.abnormal_litres_per_hour_threshold;
    if condition_active then
      if not st.is_active then
        select o.owner_user_id into owner_id
        from public.tenant_owner_profiles o join public.users u on u.id=o.owner_user_id
        where o.tenant_id=s.tenant_id and o.owner_user_id is not null and u.account_status='active'
        order by o.id limit 1;
        if owner_id is not null then
          active_episode:=st.episode_no+1;
          dedupe:='fuel-alert:'||s.id::text||':abnormal_consumption:'||active_episode::text;
          insert into public.powerhub_fuel_alert_dispatches(
            tenant_id,site_id,setting_id,alert_type,episode_no,signal_key,dedupe_key,measured_value,threshold_value,recipient_count
          ) values(s.tenant_id,s.site_id,s.id,'abnormal_consumption',active_episode,rate_signal,dedupe,rate_value,s.abnormal_litres_per_hour_threshold,0)
          returning id into dispatch_id;
          insert into public.powerhub_user_notifications(
            user_id,tenant_id,notification_type,title,body,target_path,entity_type,entity_id,dedupe_key,metadata
          ) values(owner_id,s.tenant_id,'system_alert','تنبيه استهلاك وقود غير اعتيادي',
            'المولد '||s.generator_name||' ('||s.tank_name||'): المعدل المقاس '||rate_value::text
              ||' لتر/ساعة، والحد المحدد '||s.abnormal_litres_per_hour_threshold::text||' لتر/ساعة.',
            '/inventory?tab=fuel','generator_fuel_alert',s.id::text,dedupe,
            jsonb_build_object('alert_type','abnormal_consumption','setting_id',s.id,'generator_id',s.generator_id,
              'tank_warehouse_id',s.tank_warehouse_id,'measured_value',rate_value,
              'threshold_value',s.abnormal_litres_per_hour_threshold,'episode_no',active_episode,'signal_key',rate_signal))
          on conflict(user_id,dedupe_key) do nothing;
          get diagnostics notification_rows=row_count;
          update public.powerhub_fuel_alert_dispatches d set recipient_count=notification_rows where d.id=dispatch_id;
          update public.powerhub_fuel_alert_states q set is_active=true,episode_no=active_episode,last_signal_key=rate_signal,
            last_evaluated_at=now(),last_triggered_at=now(),updated_at=now()
          where q.tenant_id=s.tenant_id and q.site_id=s.site_id and q.setting_id=s.id and q.alert_type='abnormal_consumption';
          n_rate:=n_rate+1; n_notifications:=n_notifications+notification_rows;
        else
          update public.powerhub_fuel_alert_states q set last_evaluated_at=now(),last_signal_key=rate_signal,updated_at=now()
          where q.tenant_id=s.tenant_id and q.site_id=s.site_id and q.setting_id=s.id and q.alert_type='abnormal_consumption';
        end if;
      else
        update public.powerhub_fuel_alert_states q set last_evaluated_at=now(),last_signal_key=rate_signal,updated_at=now()
        where q.tenant_id=s.tenant_id and q.site_id=s.site_id and q.setting_id=s.id and q.alert_type='abnormal_consumption';
      end if;
    elsif rate_valid and (s.abnormal_litres_per_hour_threshold is null or rate_value<=s.abnormal_litres_per_hour_threshold) then
      update public.powerhub_fuel_alert_states q set is_active=false,last_evaluated_at=now(),last_signal_key=rate_signal,updated_at=now()
      where q.tenant_id=s.tenant_id and q.site_id=s.site_id and q.setting_id=s.id and q.alert_type='abnormal_consumption';
    end if;
  end loop;

  return query select n_settings,n_low,n_rate,n_notifications;
end;
$function$;

create or replace function public.powerhub_inventory_after_fuel_insert_evaluate_alerts()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $function$
begin
  perform * from public.powerhub_inventory_evaluate_fuel_alerts(new.tenant_id,new.site_id);
  return new;
end;
$function$;

drop trigger if exists generator_fuel_events_evaluate_alerts_after_insert on public.generator_fuel_events;
create trigger generator_fuel_events_evaluate_alerts_after_insert
after insert on public.generator_fuel_events for each row
execute function public.powerhub_inventory_after_fuel_insert_evaluate_alerts();

drop trigger if exists generator_fuel_readings_evaluate_alerts_after_insert on public.generator_fuel_readings;
create trigger generator_fuel_readings_evaluate_alerts_after_insert
after insert on public.generator_fuel_readings for each row
execute function public.powerhub_inventory_after_fuel_insert_evaluate_alerts();

revoke all on function public.powerhub_inventory_upsert_fuel_alert_settings(bigint,bigint,bigint,bigint,bigint,numeric,numeric,numeric,boolean,text) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_list_fuel_alert_settings(bigint,bigint) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_list_fuel_alert_dispatches(bigint,bigint,date,date,bigint,bigint,integer) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_evaluate_fuel_alerts(bigint,bigint) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_after_fuel_insert_evaluate_alerts() from public,anon,authenticated;
grant execute on function public.powerhub_inventory_upsert_fuel_alert_settings(bigint,bigint,bigint,bigint,bigint,numeric,numeric,numeric,boolean,text) to service_role;
grant execute on function public.powerhub_inventory_list_fuel_alert_settings(bigint,bigint) to service_role;
grant execute on function public.powerhub_inventory_list_fuel_alert_dispatches(bigint,bigint,date,date,bigint,bigint,integer) to service_role;
grant execute on function public.powerhub_inventory_evaluate_fuel_alerts(bigint,bigint) to service_role;
