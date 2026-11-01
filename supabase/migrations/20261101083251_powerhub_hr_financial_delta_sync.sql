-- Bounded, minimized Delta projections for HR payroll summaries and employee advances.
-- Payroll detail rows, identity/contact/wage data, disbursement references and notes remain server-only.

alter table public.powerhub_sync_scope_state
  drop constraint if exists powerhub_sync_scope_state_entity_type_check;
alter table public.powerhub_sync_scope_state
  add constraint powerhub_sync_scope_state_entity_type_check
  check (entity_type in (
    'sites','subscribers','generators','readings','tariffs','invoices','payments','expenses',
    'company_accounts','company_accounts_all','inventory_items','inventory_item_units','suppliers',
    'inventory_warehouses','inventory_stock_movements','inventory_stocktakes','inventory_purchase_headers',
    'inventory_purchase_receipt_headers','inventory_supplier_return_headers','fuel_readings',
    'maintenance_preventive_plans','fuel_events','maintenance_work_orders','hr_employee_directory',
    'hr_attendance','hr_employee_advances','hr_payroll_runs','supplier_ledger'
  ) or entity_type ~ '^maintenance_work_order_parts:[1-9][0-9]{0,15}$');

alter table public.powerhub_sync_changes
  drop constraint if exists powerhub_sync_changes_entity_type_check;
alter table public.powerhub_sync_changes
  add constraint powerhub_sync_changes_entity_type_check
  check (entity_type in (
    'sites','subscribers','generators','readings','tariffs','invoices','payments','expenses',
    'company_accounts','company_accounts_all','inventory_items','inventory_item_units','suppliers',
    'inventory_warehouses','inventory_stock_movements','inventory_stocktakes','inventory_purchase_headers',
    'inventory_purchase_receipt_headers','inventory_supplier_return_headers','fuel_readings',
    'maintenance_preventive_plans','fuel_events','maintenance_work_orders','hr_employee_directory',
    'hr_attendance','hr_employee_advances','hr_payroll_runs'
  ) or entity_type ~ '^maintenance_work_order_parts:[1-9][0-9]{0,15}$');

alter table public.powerhub_hr_delta_scope_membership
  drop constraint if exists powerhub_hr_delta_scope_membership_entity_type_check;
alter table public.powerhub_hr_delta_scope_membership
  add constraint powerhub_hr_delta_scope_membership_entity_type_check
  check (entity_type in (
    'hr_employee_directory','hr_attendance','hr_employee_advances','hr_payroll_runs'
  ));

create or replace function public.powerhub_append_hr_delta_sync_change(
  p_tenant_id bigint,p_site_id bigint,p_entity_type text,p_entity_id text,p_change_type text,p_row_data jsonb
)
returns bigint language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_cursor bigint; v_cutoff bigint; v_row_site bigint;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1
    or p_entity_type not in (
      'hr_employee_directory','hr_attendance','hr_employee_advances','hr_payroll_runs'
    )
    or p_entity_id is null or length(p_entity_id) not between 1 and 100
    or p_change_type not in ('upsert','delete')
    or (p_change_type='upsert' and (
      p_row_data is null or p_row_data->>'id' is distinct from p_entity_id
      or nullif(p_row_data->>'tenant_id','')::bigint is distinct from p_tenant_id
    ))
    or (p_change_type='delete' and p_row_data is not null)
    or not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id)
  then raise exception 'POWERHUB_HR_DELTA_CHANGE_INVALID' using errcode='P0001'; end if;

  if p_change_type='upsert' then
    v_row_site:=nullif(p_row_data->>'site_id','')::bigint;
    if (p_entity_type in ('hr_attendance','hr_employee_advances') and v_row_site is distinct from p_site_id)
      or (p_entity_type in ('hr_employee_directory','hr_payroll_runs') and v_row_site is not null and v_row_site<>p_site_id)
    then raise exception 'POWERHUB_HR_DELTA_ROW_OUT_OF_SCOPE' using errcode='P0001'; end if;
  end if;

  insert into public.powerhub_sync_scope_state(tenant_id,site_id,entity_type,last_cursor,retained_from_cursor,updated_at)
  values(p_tenant_id,p_site_id,p_entity_type,1,0,clock_timestamp())
  on conflict(tenant_id,site_id,entity_type) do update
    set last_cursor=public.powerhub_sync_scope_state.last_cursor+1,updated_at=clock_timestamp()
  returning last_cursor into v_cursor;

  insert into public.powerhub_sync_changes(tenant_id,site_id,entity_type,cursor,entity_id,change_type,row_data,changed_at)
  values(p_tenant_id,p_site_id,p_entity_type,v_cursor,p_entity_id,p_change_type,p_row_data,clock_timestamp());

  if v_cursor>10000 and mod(v_cursor,500)=0 then
    v_cutoff:=v_cursor-10000;
    delete from public.powerhub_sync_changes c
      where c.tenant_id=p_tenant_id and c.site_id=p_site_id and c.entity_type=p_entity_type and c.cursor<=v_cutoff;
    update public.powerhub_sync_scope_state s
      set retained_from_cursor=greatest(s.retained_from_cursor,v_cutoff),updated_at=clock_timestamp()
      where s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.entity_type=p_entity_type;
  end if;
  return v_cursor;
end $$;
alter function public.powerhub_append_hr_delta_sync_change(bigint,bigint,text,text,text,jsonb) owner to postgres;
revoke all on function public.powerhub_append_hr_delta_sync_change(bigint,bigint,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.powerhub_append_hr_delta_sync_change(bigint,bigint,text,text,text,jsonb) to service_role;

create or replace function public.powerhub_project_hr_employee_advance_delta_row(
  p_tenant_id bigint,p_site_id bigint,p_adjustment_id bigint
)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,pg_temp
as $$
  select jsonb_build_object(
    'id',a.id,'tenant_id',a.tenant_id,'site_id',a.site_id,'created_at',a.created_at,
    'adjustment',jsonb_build_object(
      'id',a.id,'tenant_id',a.tenant_id,'employee_id',a.employee_id,'site_id',a.site_id,
      'adjustment_type','advance','advance_kind',a.advance_kind,
      'monthly_deduction',a.monthly_deduction,'amount',a.amount,
      'remaining_amount',a.remaining_amount,'reason',null,'status',a.status,
      'created_by_user_id',null,'created_at',a.created_at,'updated_at',a.updated_at
    ),
    'employee',jsonb_build_object(
      'id',e.id,'tenant_id',e.tenant_id,'site_id',e.site_id,
      'full_name',e.full_name,'job_title',e.job_title,'employment_status',e.employment_status
    ),
    'repayments',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',p.id,'amount',p.amount,'repayment_method',p.repayment_method,
        'company_account_id',p.company_account_id,'account_transaction_id',null,
        'payroll_run_id',p.payroll_run_id,'payment_date',p.payment_date,
        'reference_no',null,'notes',null,'created_by_user_id',null,'created_at',p.created_at
      ) order by p.payment_date desc,p.id desc)
      from (
        select r.id,r.amount,r.repayment_method,r.company_account_id,r.payroll_run_id,r.payment_date,r.created_at
        from public.employee_adjustment_repayments r
        where r.tenant_id=a.tenant_id and r.site_id=a.site_id and r.adjustment_id=a.id
        order by r.payment_date desc,r.id desc limit 4
      ) p
    ),'[]'::jsonb),
    'repayment_history_truncated',exists(
      select 1 from public.employee_adjustment_repayments r
      where r.tenant_id=a.tenant_id and r.site_id=a.site_id and r.adjustment_id=a.id
      order by r.payment_date desc,r.id desc offset 4 limit 1
    )
  )
  from public.employee_adjustments a
  join public.employees e on e.tenant_id=a.tenant_id and e.id=a.employee_id
    and (e.site_id=a.site_id or e.site_id is null)
  where a.tenant_id=p_tenant_id and a.site_id=p_site_id
    and a.id=p_adjustment_id and a.adjustment_type='advance'
$$;
alter function public.powerhub_project_hr_employee_advance_delta_row(bigint,bigint,bigint) owner to postgres;
revoke all on function public.powerhub_project_hr_employee_advance_delta_row(bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_project_hr_employee_advance_delta_row(bigint,bigint,bigint) to service_role;

create or replace function public.powerhub_project_hr_payroll_run_delta_row(
  p_tenant_id bigint,p_site_id bigint,p_payroll_run_id bigint
)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,pg_temp
as $$
  select jsonb_build_object(
    'id',r.id,'tenant_id',r.tenant_id,'site_id',r.site_id,
    'period',r.period,'status',r.status,
    'total_gross',r.total_gross,'total_deductions',r.total_deductions,'total_net',r.total_net,
    'paid_at',r.paid_at,'created_at',r.created_at,'updated_at',r.updated_at
  )
  from public.payroll_runs r
  where r.tenant_id=p_tenant_id and r.id=p_payroll_run_id
    and (r.site_id=p_site_id or r.site_id is null)
$$;
alter function public.powerhub_project_hr_payroll_run_delta_row(bigint,bigint,bigint) owner to postgres;
revoke all on function public.powerhub_project_hr_payroll_run_delta_row(bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_project_hr_payroll_run_delta_row(bigint,bigint,bigint) to service_role;

create or replace function public.powerhub_refresh_hr_employee_advances_delta_scope(
  p_tenant_id bigint,p_site_id bigint
)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_old record; v_row record; v_previous jsonb; v_projected jsonb;
begin
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  for v_old in
    select m.entity_id
    from public.powerhub_hr_delta_scope_membership m
    where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.entity_type='hr_employee_advances'
      and not exists(
        select 1 from (
          select a.id
          from public.employee_adjustments a
          join public.employees e on e.tenant_id=a.tenant_id and e.id=a.employee_id
            and (e.site_id=a.site_id or e.site_id is null)
          where a.tenant_id=p_tenant_id and a.site_id=p_site_id and a.adjustment_type='advance'
          order by a.created_at desc,a.id desc limit 500
        ) eligible where eligible.id::text=m.entity_id
      )
  loop
    delete from public.powerhub_hr_delta_scope_membership m
      where m.tenant_id=p_tenant_id and m.site_id=p_site_id
        and m.entity_type='hr_employee_advances' and m.entity_id=v_old.entity_id;
    perform public.powerhub_append_hr_delta_sync_change(
      p_tenant_id,p_site_id,'hr_employee_advances',v_old.entity_id,'delete',null
    );
  end loop;

  for v_row in
    select a.id,a.created_at
    from public.employee_adjustments a
    join public.employees e on e.tenant_id=a.tenant_id and e.id=a.employee_id
      and (e.site_id=a.site_id or e.site_id is null)
    where a.tenant_id=p_tenant_id and a.site_id=p_site_id and a.adjustment_type='advance'
    order by a.created_at desc,a.id desc limit 500
  loop
    v_projected:=public.powerhub_project_hr_employee_advance_delta_row(p_tenant_id,p_site_id,v_row.id);
    select m.row_data into v_previous
      from public.powerhub_hr_delta_scope_membership m
      where m.tenant_id=p_tenant_id and m.site_id=p_site_id
        and m.entity_type='hr_employee_advances' and m.entity_id=v_row.id::text;
    if not found then
      insert into public.powerhub_hr_delta_scope_membership(tenant_id,site_id,entity_type,entity_id,row_data)
        values(p_tenant_id,p_site_id,'hr_employee_advances',v_row.id::text,v_projected);
      perform public.powerhub_append_hr_delta_sync_change(
        p_tenant_id,p_site_id,'hr_employee_advances',v_row.id::text,'upsert',v_projected
      );
    elsif v_previous is distinct from v_projected then
      update public.powerhub_hr_delta_scope_membership m
        set row_data=v_projected,updated_at=clock_timestamp()
        where m.tenant_id=p_tenant_id and m.site_id=p_site_id
          and m.entity_type='hr_employee_advances' and m.entity_id=v_row.id::text;
      perform public.powerhub_append_hr_delta_sync_change(
        p_tenant_id,p_site_id,'hr_employee_advances',v_row.id::text,'upsert',v_projected
      );
    end if;
  end loop;
end $$;
alter function public.powerhub_refresh_hr_employee_advances_delta_scope(bigint,bigint) owner to postgres;
revoke all on function public.powerhub_refresh_hr_employee_advances_delta_scope(bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_refresh_hr_employee_advances_delta_scope(bigint,bigint) to service_role;

create or replace function public.powerhub_refresh_hr_payroll_runs_delta_scope(
  p_tenant_id bigint,p_site_id bigint
)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_old record; v_row record; v_previous jsonb; v_projected jsonb;
begin
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  for v_old in
    select m.entity_id
    from public.powerhub_hr_delta_scope_membership m
    where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.entity_type='hr_payroll_runs'
      and not exists(
        select 1 from (
          select r.id
          from public.payroll_runs r
          where r.tenant_id=p_tenant_id and (r.site_id=p_site_id or r.site_id is null)
          order by r.period desc,r.id desc limit 120
        ) eligible where eligible.id::text=m.entity_id
      )
  loop
    delete from public.powerhub_hr_delta_scope_membership m
      where m.tenant_id=p_tenant_id and m.site_id=p_site_id
        and m.entity_type='hr_payroll_runs' and m.entity_id=v_old.entity_id;
    perform public.powerhub_append_hr_delta_sync_change(
      p_tenant_id,p_site_id,'hr_payroll_runs',v_old.entity_id,'delete',null
    );
  end loop;

  for v_row in
    select r.id
    from public.payroll_runs r
    where r.tenant_id=p_tenant_id and (r.site_id=p_site_id or r.site_id is null)
    order by r.period desc,r.id desc limit 120
  loop
    v_projected:=public.powerhub_project_hr_payroll_run_delta_row(p_tenant_id,p_site_id,v_row.id);
    select m.row_data into v_previous
      from public.powerhub_hr_delta_scope_membership m
      where m.tenant_id=p_tenant_id and m.site_id=p_site_id
        and m.entity_type='hr_payroll_runs' and m.entity_id=v_row.id::text;
    if not found then
      insert into public.powerhub_hr_delta_scope_membership(tenant_id,site_id,entity_type,entity_id,row_data)
        values(p_tenant_id,p_site_id,'hr_payroll_runs',v_row.id::text,v_projected);
      perform public.powerhub_append_hr_delta_sync_change(
        p_tenant_id,p_site_id,'hr_payroll_runs',v_row.id::text,'upsert',v_projected
      );
    elsif v_previous is distinct from v_projected then
      update public.powerhub_hr_delta_scope_membership m
        set row_data=v_projected,updated_at=clock_timestamp()
        where m.tenant_id=p_tenant_id and m.site_id=p_site_id
          and m.entity_type='hr_payroll_runs' and m.entity_id=v_row.id::text;
      perform public.powerhub_append_hr_delta_sync_change(
        p_tenant_id,p_site_id,'hr_payroll_runs',v_row.id::text,'upsert',v_projected
      );
    end if;
  end loop;
end $$;
alter function public.powerhub_refresh_hr_payroll_runs_delta_scope(bigint,bigint) owner to postgres;
revoke all on function public.powerhub_refresh_hr_payroll_runs_delta_scope(bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_refresh_hr_payroll_runs_delta_scope(bigint,bigint) to service_role;

create or replace function public.powerhub_capture_hr_employee_advances_delta_sync_change()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_scope record; v_changed boolean:=true;
begin
  if TG_OP='UPDATE' then
    v_changed:=OLD.tenant_id is distinct from NEW.tenant_id
      or OLD.employee_id is distinct from NEW.employee_id
      or OLD.site_id is distinct from NEW.site_id
      or OLD.adjustment_type is distinct from NEW.adjustment_type
      or OLD.advance_kind is distinct from NEW.advance_kind
      or OLD.monthly_deduction is distinct from NEW.monthly_deduction
      or OLD.amount is distinct from NEW.amount
      or OLD.remaining_amount is distinct from NEW.remaining_amount
      or OLD.status is distinct from NEW.status
      or OLD.created_at is distinct from NEW.created_at
      or OLD.updated_at is distinct from NEW.updated_at;
    if not v_changed then return NEW; end if;
  end if;

  if TG_OP='DELETE' or (TG_OP='UPDATE' and (
      OLD.tenant_id is distinct from NEW.tenant_id or OLD.site_id is distinct from NEW.site_id
  )) then
    perform public.powerhub_refresh_hr_employee_advances_delta_scope(OLD.tenant_id,OLD.site_id);
  end if;
  if TG_OP<>'DELETE' then
    perform public.powerhub_refresh_hr_employee_advances_delta_scope(NEW.tenant_id,NEW.site_id);
    return NEW;
  end if;
  return OLD;
end $$;
alter function public.powerhub_capture_hr_employee_advances_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_hr_employee_advances_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_hr_employee_advances_delta_sync_change() to service_role;

create or replace function public.powerhub_capture_hr_advance_repayment_delta_sync_change()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_adjustment_id bigint; v_scope record;
begin
  if TG_OP<>'INSERT' then
    v_adjustment_id:=OLD.adjustment_id;
    select a.tenant_id,a.site_id into v_scope
      from public.employee_adjustments a where a.id=v_adjustment_id;
    if found then
      perform public.powerhub_refresh_hr_employee_advances_delta_scope(v_scope.tenant_id,v_scope.site_id);
    end if;
  end if;
  if TG_OP<>'DELETE' then
    v_adjustment_id:=NEW.adjustment_id;
    select a.tenant_id,a.site_id into v_scope
      from public.employee_adjustments a where a.id=v_adjustment_id;
    if found then
      perform public.powerhub_refresh_hr_employee_advances_delta_scope(v_scope.tenant_id,v_scope.site_id);
    end if;
    return NEW;
  end if;
  return OLD;
end $$;
alter function public.powerhub_capture_hr_advance_repayment_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_hr_advance_repayment_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_hr_advance_repayment_delta_sync_change() to service_role;

create or replace function public.powerhub_capture_hr_employee_advance_person_delta_sync_change()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_scope record; v_changed boolean:=true;
begin
  if TG_OP='UPDATE' then
    v_changed:=OLD.tenant_id is distinct from NEW.tenant_id
      or OLD.site_id is distinct from NEW.site_id
      or OLD.full_name is distinct from NEW.full_name
      or OLD.job_title is distinct from NEW.job_title
      or OLD.employment_status is distinct from NEW.employment_status;
    if not v_changed then return NEW; end if;
  end if;
  if TG_OP='DELETE' then
    for v_scope in select distinct a.tenant_id,a.site_id from public.employee_adjustments a
      where a.tenant_id=OLD.tenant_id and a.employee_id=OLD.id and a.adjustment_type='advance'
    loop
      perform public.powerhub_refresh_hr_employee_advances_delta_scope(v_scope.tenant_id,v_scope.site_id);
    end loop;
    return OLD;
  end if;
  for v_scope in select distinct a.tenant_id,a.site_id from public.employee_adjustments a
    where a.tenant_id=NEW.tenant_id and a.employee_id=NEW.id and a.adjustment_type='advance'
  loop
    perform public.powerhub_refresh_hr_employee_advances_delta_scope(v_scope.tenant_id,v_scope.site_id);
  end loop;
  if TG_OP='UPDATE' then
    for v_scope in select distinct a.tenant_id,a.site_id from public.employee_adjustments a
      where a.tenant_id=OLD.tenant_id and a.employee_id=OLD.id and a.adjustment_type='advance'
    loop
      perform public.powerhub_refresh_hr_employee_advances_delta_scope(v_scope.tenant_id,v_scope.site_id);
    end loop;
  end if;
  return NEW;
end $$;
alter function public.powerhub_capture_hr_employee_advance_person_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_hr_employee_advance_person_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_hr_employee_advance_person_delta_sync_change() to service_role;

create or replace function public.powerhub_capture_hr_payroll_run_delta_sync_change()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_site_id bigint;
begin
  if TG_OP='UPDATE' and OLD.tenant_id is not distinct from NEW.tenant_id
    and OLD.site_id is not distinct from NEW.site_id
    and OLD.period is not distinct from NEW.period
    and OLD.status is not distinct from NEW.status
    and OLD.total_gross is not distinct from NEW.total_gross
    and OLD.total_deductions is not distinct from NEW.total_deductions
    and OLD.total_net is not distinct from NEW.total_net
    and OLD.paid_at is not distinct from NEW.paid_at
    and OLD.created_at is not distinct from NEW.created_at
    and OLD.updated_at is not distinct from NEW.updated_at then
    return NEW;
  end if;

  if TG_OP='DELETE' or (TG_OP='UPDATE' and (
      OLD.tenant_id is distinct from NEW.tenant_id or OLD.site_id is distinct from NEW.site_id
  )) then
    if OLD.site_id is null then
      for v_site_id in select s.id from public.sites s where s.tenant_id=OLD.tenant_id order by s.id loop
        perform public.powerhub_refresh_hr_payroll_runs_delta_scope(OLD.tenant_id,v_site_id);
      end loop;
    else
      perform public.powerhub_refresh_hr_payroll_runs_delta_scope(OLD.tenant_id,OLD.site_id);
    end if;
  end if;

  if TG_OP<>'DELETE' then
    if NEW.site_id is null then
      for v_site_id in select s.id from public.sites s where s.tenant_id=NEW.tenant_id order by s.id loop
        perform public.powerhub_refresh_hr_payroll_runs_delta_scope(NEW.tenant_id,v_site_id);
      end loop;
    else
      perform public.powerhub_refresh_hr_payroll_runs_delta_scope(NEW.tenant_id,NEW.site_id);
    end if;
    return NEW;
  end if;
  return OLD;
end $$;
alter function public.powerhub_capture_hr_payroll_run_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_hr_payroll_run_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_hr_payroll_run_delta_sync_change() to service_role;

drop trigger if exists powerhub_delta_hr_employee_advances on public.employee_adjustments;
create trigger powerhub_delta_hr_employee_advances
after insert or update or delete on public.employee_adjustments
for each row execute function public.powerhub_capture_hr_employee_advances_delta_sync_change();

drop trigger if exists powerhub_delta_hr_advance_repayments on public.employee_adjustment_repayments;
create trigger powerhub_delta_hr_advance_repayments
after insert or update or delete on public.employee_adjustment_repayments
for each row execute function public.powerhub_capture_hr_advance_repayment_delta_sync_change();

drop trigger if exists powerhub_delta_hr_advance_employee_projection on public.employees;
create trigger powerhub_delta_hr_advance_employee_projection
after update of tenant_id,site_id,full_name,job_title,employment_status on public.employees
for each row execute function public.powerhub_capture_hr_employee_advance_person_delta_sync_change();

drop trigger if exists powerhub_delta_hr_payroll_runs on public.payroll_runs;
create trigger powerhub_delta_hr_payroll_runs
after insert or update or delete on public.payroll_runs
for each row execute function public.powerhub_capture_hr_payroll_run_delta_sync_change();

create or replace function public.powerhub_get_hr_sync_snapshot(
  p_tenant_id bigint,p_site_id bigint,p_entity_type text
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_cursor bigint:=0; v_retained bigint:=0; v_rows jsonb:='[]'::jsonb;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1 then
    raise exception 'POWERHUB_SYNC_SCOPE_REQUIRED' using errcode='P0001';
  end if;
  if p_entity_type not in (
    'hr_employee_directory','hr_attendance','hr_employee_advances','hr_payroll_runs'
  ) then raise exception 'POWERHUB_SYNC_ENTITY_UNSUPPORTED' using errcode='P0001'; end if;
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  if p_entity_type='hr_employee_directory' then
    perform public.powerhub_refresh_hr_employee_directory_delta_scope(p_tenant_id,p_site_id);
  elsif p_entity_type='hr_attendance' then
    perform public.powerhub_refresh_hr_attendance_delta_scope(p_tenant_id,p_site_id);
  elsif p_entity_type='hr_employee_advances' then
    perform public.powerhub_refresh_hr_employee_advances_delta_scope(p_tenant_id,p_site_id);
  else
    perform public.powerhub_refresh_hr_payroll_runs_delta_scope(p_tenant_id,p_site_id);
  end if;

  insert into public.powerhub_sync_scope_state(
    tenant_id,site_id,entity_type,last_cursor,retained_from_cursor,updated_at
  ) values(p_tenant_id,p_site_id,p_entity_type,0,0,clock_timestamp())
  on conflict(tenant_id,site_id,entity_type) do nothing;

  select s.last_cursor,s.retained_from_cursor into v_cursor,v_retained
    from public.powerhub_sync_scope_state s
    where s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.entity_type=p_entity_type
    for update;
  if not found then raise exception 'POWERHUB_HR_SNAPSHOT_SCOPE_LOCK_FAILED' using errcode='P0001'; end if;

  if p_entity_type='hr_employee_directory' then
    select coalesce(jsonb_agg(public.powerhub_project_hr_employee_delta_row(p_tenant_id,p_site_id,r.id)
      order by r.created_at desc,r.id desc),'[]'::jsonb) into v_rows
    from (
      select e.id,e.created_at from public.employees e
      where e.tenant_id=p_tenant_id and (e.site_id=p_site_id or e.site_id is null)
      order by e.created_at desc,e.id desc limit 500
    ) r;
  elsif p_entity_type='hr_attendance' then
    select coalesce(jsonb_agg(public.powerhub_project_hr_attendance_delta_row(p_tenant_id,p_site_id,r.id)
      order by r.work_date desc,r.id desc),'[]'::jsonb) into v_rows
    from (
      select a.id,a.work_date
      from public.employee_attendance a
      join public.employees e on e.tenant_id=a.tenant_id and e.id=a.employee_id
        and (e.site_id=a.site_id or e.site_id is null)
      where a.tenant_id=p_tenant_id and a.site_id=p_site_id
      order by a.work_date desc,a.id desc limit 1000
    ) r;
  else
    select coalesce(jsonb_agg(m.row_data order by
      case when p_entity_type='hr_payroll_runs' then m.row_data->>'period' end desc nulls last,
      case when p_entity_type='hr_employee_advances' then (m.row_data->>'created_at')::timestamptz end desc nulls last,
      m.entity_id::bigint desc),'[]'::jsonb) into v_rows
    from public.powerhub_hr_delta_scope_membership m
    where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.entity_type=p_entity_type;
  end if;

  return jsonb_build_object('status','ok','entity_type',p_entity_type,
    'snapshot_cursor',v_cursor::text,'retained_from_cursor',v_retained::text,'rows',v_rows);
end $$;
alter function public.powerhub_get_hr_sync_snapshot(bigint,bigint,text) owner to postgres;
revoke all on function public.powerhub_get_hr_sync_snapshot(bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_get_hr_sync_snapshot(bigint,bigint,text) to service_role;

create or replace function public.powerhub_pull_hr_sync_delta(
  p_tenant_id bigint,p_site_id bigint,p_entity_type text,p_after_cursor bigint,
  p_through_cursor bigint default null,p_page_size integer default 200
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_current bigint; v_retained bigint; v_target bigint; v_last bigint; v_next bigint;
  v_changes jsonb; v_more boolean;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1
    or p_entity_type not in ('hr_employee_directory','hr_attendance','hr_employee_advances','hr_payroll_runs')
    or p_after_cursor is null or p_after_cursor<0
    or (p_through_cursor is not null and p_through_cursor<p_after_cursor)
    or p_page_size is null or p_page_size not between 1 and 500
  then raise exception 'POWERHUB_SYNC_CURSOR_INVALID' using errcode='P0001'; end if;
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select s.last_cursor,s.retained_from_cursor into v_current,v_retained
    from public.powerhub_sync_scope_state s
    where s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.entity_type=p_entity_type;
  v_current:=coalesce(v_current,0); v_retained:=coalesce(v_retained,0);
  if p_after_cursor>v_current then raise exception 'POWERHUB_SYNC_CURSOR_AHEAD' using errcode='P0001'; end if;
  if p_after_cursor<v_retained then
    return jsonb_build_object('status','reset_required','entity_type',p_entity_type,
      'current_cursor',v_current::text,'retained_from_cursor',v_retained::text,
      'snapshot_cursor',v_current::text,'through_cursor',v_current::text,
      'next_cursor',null,'has_more',false,'changes','[]'::jsonb);
  end if;
  v_target:=least(v_current,coalesce(p_through_cursor,v_current));
  with page as (
    select c.cursor,c.entity_type,c.entity_id,c.change_type,c.row_data,c.changed_at
    from public.powerhub_sync_changes c
    where c.tenant_id=p_tenant_id and c.site_id=p_site_id
      and c.entity_type=p_entity_type and c.cursor>p_after_cursor and c.cursor<=v_target
    order by c.cursor limit p_page_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'cursor',p.cursor::text,'entity_type',p.entity_type,'entity_id',p.entity_id,
    'operation',p.change_type,'row_data',p.row_data,'changed_at',p.changed_at
  ) order by p.cursor),'[]'::jsonb),max(p.cursor)
  into v_changes,v_last from page p;
  v_next:=coalesce(v_last,p_after_cursor);
  select exists(select 1 from public.powerhub_sync_changes c
    where c.tenant_id=p_tenant_id and c.site_id=p_site_id and c.entity_type=p_entity_type
      and c.cursor>coalesce(v_last,p_after_cursor) and c.cursor<=v_target) into v_more;
  return jsonb_build_object('status','ok','entity_type',p_entity_type,
    'current_cursor',v_current::text,'retained_from_cursor',v_retained::text,
    'snapshot_cursor',null,'through_cursor',v_target::text,'next_cursor',v_next::text,
    'has_more',v_more,'changes',v_changes);
end $$;
alter function public.powerhub_pull_hr_sync_delta(bigint,bigint,text,bigint,bigint,integer) owner to postgres;
revoke all on function public.powerhub_pull_hr_sync_delta(bigint,bigint,text,bigint,bigint,integer) from public,anon,authenticated;
grant execute on function public.powerhub_pull_hr_sync_delta(bigint,bigint,text,bigint,bigint,integer) to service_role;
